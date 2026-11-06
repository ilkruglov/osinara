/**
 * The cloud browser helper the sandbox runs (`agent/skills/agent-browser/scripts/browserless.mjs`).
 *
 * Constructs covered:
 * - It only reads: commands that act on the page are refused, and so is every argument that runs
 *   script in the page (`wait --fn`), which would submit or fill a form past browser_act's
 *   confirmation (Codex review, 6 November 2026).
 */
import { describe, expect, it } from "vitest";

// @ts-expect-error -- a plain ES module of the skill package, without types
import { main } from "../../skills/agent-browser/scripts/browserless.mjs";

describe("browserless helper", () => {
  it.each([
    [["click", "@e1"]],
    [["wait", "--fn", "(document.querySelector('form').requestSubmit(),true)"]],
    [["wait", "-f", "document.forms[0].submit()"]],
    [["wait", "--fn=document.forms[0].submit()"]],
    [["get", "text", "--fn", "x"]],
  ])("refuses %j before touching the browser", async (argv) => {
    await expect(main(argv)).rejects.toThrow(/AGENT_BROWSERLESS_COMMAND_FORBIDDEN/u);
  });
});
