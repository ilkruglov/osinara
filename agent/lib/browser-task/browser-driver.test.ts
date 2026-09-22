/**
 * Browser driver tests.
 *
 * Constructs covered:
 * - Every command is one bounded agent-browser process in the session sandbox.
 * - Refs and text are shell-quoted; the snapshot is parsed into the element table.
 * - Text clicks run a shadow-DOM walk through eval; a frame is entered by opening its src.
 * - A failed command becomes a model-facing error without the query string.
 */
import { describe, expect, it, vi } from "vitest";

import type { SandboxRunnerClient } from "../sandbox-runner/runner-client.js";
import { createSandboxBrowserDriver } from "./browser-driver.js";

type Runner = Pick<SandboxRunnerClient, "run"> & { run: ReturnType<typeof vi.fn> };

function runner(responses: Record<string, string>): Runner {
  const run = vi.fn(async (_sessionId: string, request: { command: string }) => {
    const plain = request.command.replace(/'/gu, "");
    const key = Object.keys(responses).find((candidate) => plain.includes(candidate));
    return key === undefined
      ? { exitCode: 1, stderr: "Unknown command", stdout: "" }
      : { exitCode: 0, stderr: "", stdout: responses[key]! };
  });
  return { run } as unknown as Runner;
}

describe("createSandboxBrowserDriver", () => {
  it("runs agent-browser in the session sandbox and parses the snapshot", async () => {
    const r = runner({ "get url": "https://b-frant.ru/\n", "get title": "Франт\n", "snapshot": `- button "Записаться" [ref=e1]\n` });
    const driver = createSandboxBrowserDriver({ runner: r, sandboxSessionId: "sbx-1" });

    const page = await driver.snapshot();

    expect(page.url).toBe("https://b-frant.ru/");
    expect(page.title).toBe("Франт");
    expect(page.table.elements[0]).toMatchObject({ ref: "e1", role: "button" });
    expect(r.run.mock.calls[0]![0]).toBe("sbx-1");
    expect(r.run.mock.calls[0]![1].command).toMatch(/^timeout --signal=TERM --kill-after=5s 45s agent-browser /u);
  });

  it("quotes refs and text for the shell", async () => {
    const r = runner({ fill: "" });

    await createSandboxBrowserDriver({ runner: r, sandboxSessionId: "s" }).fill("e9", `Илья "Круглов" O'Neil`);

    expect(r.run.mock.calls[0]![1].command).toContain(`fill '@e9' 'Илья "Круглов" O'\\''Neil'`);
  });

  it("clicks text through an eval that walks shadow roots", async () => {
    const r = runner({ eval: `"CLICKED"\n` });

    await createSandboxBrowserDriver({ runner: r, sandboxSessionId: "s" }).clickText("18:15");

    const command = r.run.mock.calls[0]![1].command;
    expect(command).toContain("agent-browser eval ");
    expect(command).toContain("shadowRoot");
    expect(command).toContain('"18:15"');
  });

  it("reports a text that no element carries", async () => {
    const r = runner({ eval: `"NOT_FOUND"\n` });

    await expect(createSandboxBrowserDriver({ runner: r, sandboxSessionId: "s" }).clickText("нет такого"))
      .rejects.toMatchObject({ code: "AGENT_BROWSER_TASK_TEXT_NOT_FOUND" });
  });

  it("enters a frame by opening its src", async () => {
    const r = runner({ "get attr": "https://b20106.yclients.ru/?x=1\n", open: "" });

    await createSandboxBrowserDriver({ runner: r, sandboxSessionId: "s" }).enterFrame("e22");

    expect(r.run.mock.calls[1]![1].command).toContain(`open 'https://b20106.yclients.ru/?x=1'`);
  });

  it("turns a failed command into a model-facing error without the query string", async () => {
    const r = { run: vi.fn(async () => ({ exitCode: 1, stderr: "Element not found: https://x.ru/page?token=secret rest", stdout: "" })) } as unknown as Runner;

    const error = await createSandboxBrowserDriver({ runner: r, sandboxSessionId: "s" }).click("e1").catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "AGENT_BROWSER_TASK_BROWSER_FAILED", contract: { retryable: false } });
    expect(String((error as { contract: { reason: string } }).contract.reason)).not.toContain("secret");
    expect((error as { contract: { reason: string } }).contract.reason).toContain("Element not found");
  });
});
