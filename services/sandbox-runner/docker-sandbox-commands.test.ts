/**
 * Sandbox command builder tests.
 *
 * Constructs covered:
 * - A path with `$(...)`, backticks, quotes and spaces reaches the shell as one literal argument:
 *   the commands run through a real bash against a temporary directory.
 * - Control characters in a path are rejected before any command is built.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { assertShellSafePath } from "./docker-sandbox-commands.js";
import { shellQuote } from "../../agent/lib/sandbox-runner/sandbox-runner-contract.js";

const run = promisify(execFile);
const HOSTILE = "/workspace/group/$(touch \"/tmp/pwned\")`id`'quote' and space.txt";

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
  });
});

describe("assertShellSafePath", () => {
  it("rejects control characters and accepts ordinary hostile punctuation", () => {
    expect(() => assertShellSafePath("/workspace/a\nb")).toThrow(/AGENT_SANDBOX_RUNNER_PATH_INVALID/u);
    expect(() => assertShellSafePath("/workspace/a\u0000b")).toThrow(/AGENT_SANDBOX_RUNNER_PATH_INVALID/u);
    expect(() => assertShellSafePath(HOSTILE)).not.toThrow();
  });
});
