/**
 * Browser driver tests.
 *
 * Constructs covered:
 * - Every command is one bounded agent-browser process in the session sandbox, arguments quoted.
 * - `eval` returns the value the page produced, unquoted.
 * - A failed command becomes a model-facing error without the query string; a slow `open` and a
 *   never-settling page do not fail the step.
 */
import { describe, expect, it, vi } from "vitest";

import type { SandboxRunnerClient } from "../sandbox-runner/runner-client.js";
import { createSandboxBrowserDriver } from "./browser-driver.js";

type Runner = Pick<SandboxRunnerClient, "run"> & { run: ReturnType<typeof vi.fn> };

function runner(responses: Record<string, string | { fail: string }>): Runner {
  const run = vi.fn(async (_sessionId: string, request: { command: string }) => {
    const plain = request.command.replace(/'/gu, "");
    const key = Object.keys(responses).find((candidate) => plain.includes(candidate));
    const response = key === undefined ? undefined : responses[key];
    if (response === undefined) return { exitCode: 1, stderr: "Unknown command", stdout: "" };
    if (typeof response === "object") return { exitCode: 1, stderr: response.fail, stdout: "" };
    return { exitCode: 0, stderr: "", stdout: response };
  });
  return { run } as unknown as Runner;
}

describe("createSandboxBrowserDriver", () => {
  it("runs bounded agent-browser commands in the session sandbox with quoted arguments", async () => {
    const r = runner({ eval: "\"[1] link Записаться\"\n", "get url": "https://x.ru/a?b=1\n" });
    const driver = createSandboxBrowserDriver({ runner: r, sandboxSessionId: "sbx-1" });

    expect(await driver.eval("(() => 'it\\'s')()")).toBe("[1] link Записаться");
    expect(await driver.url()).toBe("https://x.ru/a?b=1");

    const [sessionId, request] = r.run.mock.calls[0]!;
    expect(sessionId).toBe("sbx-1");
    expect(request.command).toMatch(/^timeout --signal=TERM --kill-after=5s 45s agent-browser eval '/u);
    expect(request.command).toContain(`'\\''s`);
  });

  it("turns a failed command into a model-facing error without the query string", async () => {
    const r = runner({ "get url": { fail: "✗ Timeout at https://x.ru/book?token=SECRET more" } });
    await expect(createSandboxBrowserDriver({ runner: r, sandboxSessionId: "s" }).url()).rejects.toMatchObject({
      code: "AGENT_BROWSER_FAILED",
      contract: { reason: expect.not.stringContaining("SECRET") },
    });
  });

  it("tolerates a slow open and a page that never settles", async () => {
    const r = runner({ open: { fail: "✗ Operation timed out" }, "wait --load": { fail: "✗ Timeout" }, "wait 400": "" });
    const driver = createSandboxBrowserDriver({ runner: r, sandboxSessionId: "s" });
    await expect(driver.open("https://x.ru/")).resolves.toBeUndefined();
    await expect(driver.settle()).resolves.toBeUndefined();
    expect(r.run.mock.calls.map((c) => c[1].command)).toEqual(expect.arrayContaining([expect.stringContaining("wait '400'")]));
  });

  it("reports an open that failed before navigating", async () => {
    const r = runner({ open: { fail: "✗ CDP WebSocket connect failed" } });
    await expect(createSandboxBrowserDriver({ runner: r, sandboxSessionId: "s" }).open("https://x.ru/")).rejects.toMatchObject({ code: "AGENT_BROWSER_FAILED" });
  });
});
