/**
 * Browser driver tests.
 *
 * Constructs covered:
 * - Every command is one bounded agent-browser process in the session sandbox, arguments quoted.
 * - `eval` returns the value the page produced, unquoted.
 * - A failed command becomes a model-facing error without the query string; a slow `open` and a
 *   never-settling page do not fail the step, whether the CLI bound or the runner reports the time.
 * - The screenshot directory is created with the screenshot.
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
    expect(request.command).toMatch(/^timeout --signal=TERM --kill-after=3s 40s agent-browser eval '/u);
    expect(request.command).toContain(`'\\''s`);
  });

  it("turns a failed command into a model-facing error without the query string", async () => {
    const r = runner({ "get url": { fail: "✗ Navigation failed at https://x.ru/book?token=SECRET more" } });
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

  // passport.yandex.ru, 26 September 2026: the first load ran past the CLI bound, the runner
  // reported its own marker and the old `timed out` match missed it; the whole turn went into
  // diagnosing a page that was already open.
  it("treats the CLI bound and the runner timeout as a slow open, not a failure", async () => {
    const byExit = vi.fn(async (_sessionId: string, _request: { command: string }) => ({ exitCode: 124, stderr: "", stdout: "" }));
    await expect(createSandboxBrowserDriver({ runner: { run: byExit } as unknown as Runner, sandboxSessionId: "s" }).open("https://x.ru/")).resolves.toBeUndefined();
    expect(byExit.mock.calls[0]![1].command).toMatch(/^timeout --signal=TERM --kill-after=3s 40s agent-browser open /u);
    const byRunner = runner({ open: { fail: "AGENT_SANDBOX_RUNNER_PROCESS_TIMED_OUT: Command exceeded 50000 ms" } });
    await expect(createSandboxBrowserDriver({ runner: byRunner, sandboxSessionId: "s" }).open("https://x.ru/")).resolves.toBeUndefined();
    // Any other command still reports the timeout, under its own code.
    await expect(createSandboxBrowserDriver({ runner: { run: byExit } as unknown as Runner, sandboxSessionId: "s" }).url()).rejects.toMatchObject({ code: "AGENT_BROWSER_TIMEOUT" });
  });

  it("creates the screenshot directory in the same command", async () => {
    const r = runner({ screenshot: "✓ Screenshot saved" });
    await createSandboxBrowserDriver({ runner: r, sandboxSessionId: "s" }).screenshot("/workspace/personal/shots/look-1.png");
    expect(r.run.mock.calls[0]![1].command).toMatch(/^mkdir -p '\/workspace\/personal\/shots' && timeout .* agent-browser screenshot '\/workspace\/personal\/shots\/look-1.png'$/u);
  });

  it("reports an open that failed before navigating", async () => {
    const r = runner({ open: { fail: "✗ CDP WebSocket connect failed" } });
    await expect(createSandboxBrowserDriver({ runner: r, sandboxSessionId: "s" }).open("https://x.ru/")).rejects.toMatchObject({ code: "AGENT_BROWSER_FAILED" });
  });
});
