/**
 * Atomic Docker seed archive construction.
 *
 * Export:
 * - `writeSandboxSeedArchive`: uploads all validated seed files through one Docker archive stream.
 *
 * Key construct:
 * - The sandbox root filesystem is read-only, and Docker's archive API writes only into volumes
 *   (checked live, 5 October 2026: `docker cp` to `/`, to `/root` and to a tmpfs is refused). The
 *   seed is extracted into a fresh directory under the container's staging directory, then copied
 *   into place by tar inside the container, file by file, which writes wherever the container
 *   itself may (volumes and tmpfs), keeping the file modes and leaving existing directories as
 *   they are.
 */
import { randomUUID } from "node:crypto";

import type Docker from "dockerode";
import tar from "tar-stream";

import { shellQuote, type SandboxRunnerSeedFile } from "../../agent/lib/sandbox-runner/sandbox-runner-contract.js";
import { executeSandboxProcess } from "./docker-sandbox-process.js";

const SEED_FILE_MODE = 0o600;
const SEED_TIMEOUT_MS = 2 * 60 * 1_000;

async function addEntry(pack: tar.Pack, file: SandboxRunnerSeedFile): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    pack.entry({
      mode: SEED_FILE_MODE,
      name: file.path.slice(1),
      type: "file",
    }, Buffer.from(file.contentBase64, "base64"), (error) => error ? reject(error) : resolve());
  });
}

async function run(docker: Docker, container: Docker.Container, command: string, failure: string): Promise<void> {
  const result = await executeSandboxProcess(docker, container, { command, timeoutMs: SEED_TIMEOUT_MS });
  if (result.exitCode !== 0) throw new Error(`${failure}: ${result.stderr.slice(0, 400)}`);
}

export async function writeSandboxSeedArchive(
  docker: Docker,
  container: Docker.Container,
  files: readonly SandboxRunnerSeedFile[],
  stagingDirectory: string,
): Promise<void> {
  if (files.length === 0) return;
  const unpacked = `${stagingDirectory}/seed-${randomUUID()}`;
  await run(docker, container, `mkdir -p -- ${shellQuote(unpacked)}`, "AGENT_SANDBOX_RUNNER_SEED_FAILED");
  try {
    // Docker consumes the stream while entries are produced, avoiding a second in-memory archive copy.
    const pack = tar.pack();
    const upload = container.putArchive(pack, { path: unpacked });
    for (const file of files) await addEntry(pack, file);
    pack.finalize();
    await upload;
    await run(
      docker,
      container,
      // Files only: a directory entry would make tar set the mode of existing directories (`/`,
      // the mount points) on the read-only root; missing parents are created as needed.
      `cd ${shellQuote(unpacked)} && find . -type f -print0 | tar --null --no-recursion -T - -cf - | tar -C / -xpf -`,
      "AGENT_SANDBOX_RUNNER_SEED_FAILED",
    );
  } finally {
    await run(docker, container, `rm -rf -- ${shellQuote(unpacked)}`, "AGENT_SANDBOX_RUNNER_SEED_CLEANUP_FAILED")
      .catch((error: unknown) => console.error(JSON.stringify({
        code: "AGENT_SANDBOX_RUNNER_SEED_CLEANUP_FAILED",
        error: error instanceof Error ? error.message.slice(0, 200) : String(error),
      })));
  }
}
