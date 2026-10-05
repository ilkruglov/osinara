/**
 * Moving bytes into and out of a sandbox through a process inside it.
 *
 * Exports:
 * - `writeContainerFile`: one file, written by `cat` from stdin and renamed into place.
 * - `readContainerFile`: one regular file through stdout, size-checked; null when absent.
 * - `writeSeedFiles`: many files at once, a tar archive on stdin extracted by tar.
 * - `FILE_MISSING_EXIT_CODE`, `FILE_TOO_LARGE_EXIT_CODE`.
 *
 * Key construct:
 * - The sandbox root is read-only, and Docker's archive API writes and reads only on volumes:
 *   neither the root nor a tmpfs such as a restricted HOME (checked live, 5 October 2026). The
 *   runner used a staging directory, first on the root, then on the container's volume, where
 *   the model's Bash (and another topic of the same group) could replace files between the
 *   upload and the move (Codex review, 5 October 2026). Here the bytes never rest anywhere the
 *   model can reach before they are in place: they travel on the process's stdin and stdout, and
 *   the process writes wherever the container itself may.
 */
import { PassThrough, type Duplex } from "node:stream";

import type Docker from "dockerode";
import tar from "tar-stream";

import type { SandboxRunnerSeedFile } from "../../agent/lib/sandbox-runner/sandbox-runner-contract.js";
import { collectLimitedStream } from "./docker-sandbox-files.js";

export const FILE_MISSING_EXIT_CODE = 44;
export const FILE_TOO_LARGE_EXIT_CODE = 45;
const TRANSFER_TIMEOUT_SECONDS = 120;
const STDERR_MAX_BYTES = 64 * 1024;
const FILE_MODE = 0o600;

/** One process with optional stdin; stdout bounded, stderr kept short. */
async function runWithInput(
  docker: Docker,
  container: Docker.Container,
  argv: readonly string[],
  options: { maxStdoutBytes: number; stdin?: Buffer },
): Promise<{ exitCode: number; stderr: string; stdout: Buffer }> {
  const exec = await container.exec({
    AttachStderr: true,
    AttachStdin: options.stdin !== undefined,
    AttachStdout: true,
    Cmd: ["timeout", "--signal=KILL", String(TRANSFER_TIMEOUT_SECONDS), ...argv],
    Tty: false,
    WorkingDir: "/",
  });
  const stream = (await exec.start({ hijack: true, stdin: options.stdin !== undefined, Tty: false })) as Duplex;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on("error", () => undefined);
  stderr.on("error", () => undefined);
  docker.modem.demuxStream(stream, stdout, stderr);
  stream.once("end", () => {
    stdout.end();
    stderr.end();
  });
  stream.once("error", (error) => {
    stdout.destroy(error);
    stderr.destroy(error);
  });
  // The whole input at once, then the write side closed so the process sees end of file.
  if (options.stdin !== undefined) stream.end(options.stdin);
  let out: Buffer;
  let err: Buffer;
  try {
    [out, err] = await Promise.all([
      collectLimitedStream(stdout, options.maxStdoutBytes),
      collectLimitedStream(stderr, STDERR_MAX_BYTES).catch(() => Buffer.alloc(0)),
    ]);
  } catch (error) {
    stream.destroy();
    throw error;
  }
  const inspection = await exec.inspect();
  return { exitCode: inspection.ExitCode ?? -1, stderr: err.toString("utf8"), stdout: out };
}

// The target's own directory holds the temporary file, so the final rename is atomic; a target
// that is a directory makes `mv -T` fail instead of nesting the file inside it.
const WRITE_SCRIPT = [
  "set -e",
  "target=$1",
  "dir=$(dirname -- \"$target\")",
  "mkdir -p -- \"$dir\"",
  "tmp=$(mktemp -p \"$dir\" .osinara-write.XXXXXXXX)",
  "trap 'rm -f -- \"$tmp\"' EXIT",
  "cat > \"$tmp\"",
  `chmod ${FILE_MODE.toString(8)} -- "$tmp"`,
  "mv -T -- \"$tmp\" \"$target\"",
  "trap - EXIT",
].join("\n");

export async function writeContainerFile(
  docker: Docker,
  container: Docker.Container,
  path: string,
  content: Uint8Array,
): Promise<void> {
  const result = await runWithInput(docker, container, ["bash", "-c", WRITE_SCRIPT, "osinara-write", path], {
    maxStdoutBytes: STDERR_MAX_BYTES,
    stdin: Buffer.from(content),
  });
  if (result.exitCode !== 0) {
    throw new Error(`AGENT_SANDBOX_RUNNER_FILE_COMMIT_FAILED: Не удалось записать файл в sandbox. ${result.stderr.slice(0, 400)}`);
  }
}

/** The file's bytes; null when there is no regular file at `path`. */
export async function readContainerFile(
  docker: Docker,
  container: Docker.Container,
  path: string,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const script = [
    "f=$1",
    `[ -f "$f" ] || exit ${FILE_MISSING_EXIT_CODE}`,
    `[ "$(stat -c %s -- "$f")" -le ${Math.floor(maxBytes)} ] || exit ${FILE_TOO_LARGE_EXIT_CODE}`,
    "exec cat -- \"$f\"",
  ].join("\n");
  let result: Awaited<ReturnType<typeof runWithInput>>;
  try {
    result = await runWithInput(docker, container, ["bash", "-c", script, "osinara-read", path], { maxStdoutBytes: maxBytes });
  } catch (error) {
    // The file grew past the limit between the size check and the read.
    if (error instanceof Error && error.message.includes("AGENT_SANDBOX_RUNNER_OUTPUT_TOO_LARGE")) result = { exitCode: FILE_TOO_LARGE_EXIT_CODE, stderr: "", stdout: Buffer.alloc(0) };
    else throw error;
  }
  if (result.exitCode === FILE_MISSING_EXIT_CODE) return null;
  if (result.exitCode === FILE_TOO_LARGE_EXIT_CODE) {
    throw new Error(`AGENT_SANDBOX_RUNNER_FILE_TOO_LARGE: Файл sandbox больше допустимых ${maxBytes} байт`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`AGENT_SANDBOX_RUNNER_FILE_READ_FAILED: Не удалось прочитать файл sandbox. ${result.stderr.slice(0, 400)}`);
  }
  return new Uint8Array(result.stdout);
}

/** The seed as one tar of regular files (no directory entries, so existing directories keep their modes). */
async function seedArchive(files: readonly SandboxRunnerSeedFile[]): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    pack.on("data", (chunk: Buffer) => chunks.push(chunk));
    pack.on("end", () => resolve(Buffer.concat(chunks)));
    pack.on("error", reject);
  });
  for (const file of files) {
    pack.entry({ mode: FILE_MODE, name: file.path.slice(1), type: "file" }, Buffer.from(file.contentBase64, "base64"));
  }
  pack.finalize();
  return await done;
}

export async function writeSeedFiles(
  docker: Docker,
  container: Docker.Container,
  files: readonly SandboxRunnerSeedFile[],
): Promise<void> {
  if (files.length === 0) return;
  const result = await runWithInput(docker, container, ["tar", "-xpf", "-", "-C", "/"], {
    maxStdoutBytes: STDERR_MAX_BYTES,
    stdin: await seedArchive(files),
  });
  if (result.exitCode !== 0) {
    throw new Error(`AGENT_SANDBOX_RUNNER_SEED_FAILED: ${result.stderr.slice(0, 400)}`);
  }
}
