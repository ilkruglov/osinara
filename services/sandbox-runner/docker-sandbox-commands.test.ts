/**
 * Sandbox command builder tests.
 *
 * Constructs covered:
 * - A path with `$(...)`, backticks, quotes and spaces reaches the shell as one literal argument:
 *   the commands run through a real bash against a temporary directory.
 * - The read staging command refuses a missing file and a file above the limit before copying.
 * - Control characters in a path are rejected before any command is built.
 */
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  assertShellSafePath,
  commitStagedFileCommand,
  FILE_MISSING_EXIT_CODE,
  FILE_TOO_LARGE_EXIT_CODE,
  stageFileForReadCommand,
} from "./docker-sandbox-commands.js";
import { shellQuote } from "../../agent/lib/sandbox-runner/sandbox-runner-contract.js";

const run = promisify(execFile);
const HOSTILE = "/workspace/group/$(touch \"/tmp/pwned\")`id`'quote' and space.txt";
const HOSTILE_DIRECTORY = "/workspace/group/$(touch \"/tmp/pwned\")`id`'quote' and space";

async function bash(command: string): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await run("bash", ["-c", command]);
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "" };
  }
}

describe("shellQuote", () => {
  it("keeps every character literal through bash", async () => {
    const { stdout } = await bash(`printf '%s' ${shellQuote(HOSTILE)}`);
    expect(stdout).toBe(HOSTILE);
    const { stdout: moved } = await bash(
      `mkdir() { :; }; mv() { printf '%s|%s' "$3" "$4"; }; ${commitStagedFileCommand({
        resolvedPath: HOSTILE,
        stagingPath: "/.osinara-sandbox-uploads/x",
        targetDirectory: HOSTILE_DIRECTORY,
      })}`,
    );
    expect(moved).toBe(`/.osinara-sandbox-uploads/x|${HOSTILE}`);
  });
});

describe("stageFileForReadCommand", () => {
  it("refuses a missing or oversized file before copying and copies a hostile name literally", async () => {
    const directory = await mkdtemp(join(tmpdir(), "osinara-sandbox-"));
    const hostile = join(directory, "$(touch pwned)`id` file.txt");
    await writeFile(hostile, "hello");
    const staging = join(directory, "staging");
    const build = (resolvedPath: string, maxBytes: number) => stageFileForReadCommand({
      maxBytes, resolvedPath, stagingDirectory: staging, stagingPath: join(staging, "copy"),
    });

    expect((await bash(build(join(directory, "absent"), 100))).code).toBe(FILE_MISSING_EXIT_CODE);
    expect((await bash(build(hostile, 2))).code).toBe(FILE_TOO_LARGE_EXIT_CODE);
    expect((await bash(build(hostile, 100))).code).toBe(0);
    const { stdout } = await bash(
      `cat ${shellQuote(join(staging, "copy"))}; test -e ${shellQuote(join(directory, "pwned"))} && echo PWNED`,
    );
    expect(stdout).toBe("hello");
  });
});

describe("assertShellSafePath", () => {
  it("rejects control characters and accepts ordinary hostile punctuation", () => {
    expect(() => assertShellSafePath("/workspace/a\nb")).toThrow(/AGENT_SANDBOX_RUNNER_PATH_INVALID/u);
    expect(() => assertShellSafePath("/workspace/a\u0000b")).toThrow(/AGENT_SANDBOX_RUNNER_PATH_INVALID/u);
    expect(() => assertShellSafePath(HOSTILE)).not.toThrow();
  });
});
