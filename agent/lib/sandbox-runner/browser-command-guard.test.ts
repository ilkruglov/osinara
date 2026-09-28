/**
 * Bash must not drive the Chromium session the browser tools own.
 *
 * Constructs covered:
 * - A Bash command that invokes `agent-browser` against the default session is refused with a
 *   stable code before it reaches the runner.
 * - The reader session (Lightpanda) and commands without agent-browser pass.
 */
import { describe, expect, it } from "vitest";

import { BROWSER_COMMAND_FORBIDDEN, refuseBrowserCommand } from "./browser-command-guard.js";

describe("refuseBrowserCommand", () => {
  it("refuses agent-browser against the tools' Chromium session", () => {
    for (const command of [
      "timeout --signal=TERM --kill-after=5s 60s agent-browser click e5 2>&1 | head -c 600",
      "agent-browser fill e24 '+79265474577'",
      "cd /workspace && AGENT_BROWSER_SESSION=osinara agent-browser open https://x.ru",
      "agent-browser --session osinara screenshot /workspace/personal/shots/a.png",
      // Review 28 September 2026: a comment, quotes, a path or a second command must not unlock the session.
      "agent-browser click e5 # --session osinara-reader",
      "'agent-browser' click e5",
      "\"agent-browser\" fill e24 '+79265474577'",
      "/usr/local/bin/agent-browser click e5",
      "agent-browser --session osinara-reader read; agent-browser click e5",
      "agent-browser --session osinara-reader read && agent-browser fill e24 x",
      "agent-browser --session osinara-reader read | agent-browser click e5",
      "echo $(agent-browser click e5)",
      "agent-browser --session=osinara click e5",
      "agent-browser --session osinara-reader-2 click e5",
      // Second review: a single &, a flag inside a string, nested shells, escapes and glued quotes.
      "agent-browser click e5 & echo --session osinara-reader",
      "agent-browser eval 'console.log(\" --session osinara-reader \")'",
      "bash -c 'agent-browser click e5' --session osinara-reader",
      "sh -c agent-browser --session osinara-reader click e5",
      "echo e5 | xargs agent-browser --session osinara-reader click",
      "agent\\-browser click e5",
      "agent-\"\"browser click e5",
      "a=agent; $a-browser click e5",
      "/usr/local/bin/agent-b* click e5",
    ]) {
      expect(refuseBrowserCommand(command)).toMatchObject({ exitCode: 126, stderr: expect.stringContaining(BROWSER_COMMAND_FORBIDDEN) });
    }
  });

  it("lets the reader session and ordinary commands through", () => {
    expect(refuseBrowserCommand("timeout 45s agent-browser --session osinara-reader --engine lightpanda open https://x.ru")).toBeNull();
    expect(refuseBrowserCommand("agent-browser --session osinara-reader --engine lightpanda read")).toBeNull();
    expect(refuseBrowserCommand("ls /workspace/personal/shots && cat notes.md")).toBeNull();
    expect(refuseBrowserCommand("agent-browser --session=osinara-reader --engine lightpanda read")).toBeNull();
    expect(refuseBrowserCommand("agent-browser --session 'osinara-reader' read | head -c 600 # notes")).toBeNull();
    expect(refuseBrowserCommand("timeout 45s agent-browser --session osinara-reader open https://x.ru && ls")).toBeNull();
    expect(refuseBrowserCommand("agent-browser \\\n  --session osinara-reader read")).toBeNull();
    expect(refuseBrowserCommand("agent-browser '--session' osinara-reader read")).toBeNull();
    expect(refuseBrowserCommand("agent-browser --session osinara-reader open https://x.ru; agent-browser --session osinara-reader read")).toBeNull();
    expect(refuseBrowserCommand("node \"$HOME/.agents/skills/agent-browser/scripts/browserless.mjs\" status")).toBeNull();
  });
});
