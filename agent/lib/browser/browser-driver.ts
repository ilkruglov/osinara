/**
 * The browser of one trust zone, driven through `agent-browser` in the zone's sandbox.
 *
 * Exports:
 * - `BrowserDriver`: open, eval, screenshot, text, key press, scroll, back, settle, url.
 * - `createSandboxBrowserDriver`: production driver over the sandbox runner.
 *
 * Key constructs:
 * - Every call is one bounded `agent-browser` process in the sandbox session; the CLI keeps one
 *   Chromium per session (`osinara`), so cookies and logins outlive a task.
 * - No element refs: the page is marked and acted on through `som-script.ts`, so the driver only
 *   evaluates scripts and never has to know which number is which.
 * - `settle()` waits for a navigation to land before the next look, bounded so a page that never
 *   settles (analytics, long polling) cannot hold a step.
 */
import { ModelFacingError } from "../model-facing-error.js";
import type { SandboxRunnerClient } from "../sandbox-runner/runner-client.js";

export interface BrowserDriver {
  back(): Promise<void>;
  eval(script: string): Promise<string>;
  open(url: string): Promise<void>;
  press(key: string): Promise<void>;
  readText(): Promise<string>;
  screenshot(path: string): Promise<void>;
  scroll(direction: "down" | "up"): Promise<void>;
  settle(): Promise<void>;
  url(): Promise<string>;
}

const COMMAND_TIMEOUT_MS = 50_000;
const SETTLE_MS = 400;
const DIAGNOSTIC_MAX_CHARACTERS = 400;
const quote = (value: string): string => `'${value.replace(/'/gu, `'\\''`)}'`;

export function createSandboxBrowserDriver(input: {
  runner: Pick<SandboxRunnerClient, "run">;
  sandboxSessionId: string;
  signal?: AbortSignal;
}): BrowserDriver {
  async function ab(...args: string[]): Promise<string> {
    const [subcommand, ...rest] = args;
    const command = `timeout --signal=TERM --kill-after=5s 45s agent-browser ${[subcommand, ...rest.map(quote)].join(" ")}`;
    const result = await input.runner.run(input.sandboxSessionId, { command, timeoutMs: COMMAND_TIMEOUT_MS }, input.signal);
    if (result.exitCode !== 0) {
      // Query strings carry tokens and booking ids; the model needs the error, not the URL.
      const detail = `${result.stderr}\n${result.stdout}`.replace(/\?[^\s'"]*/gu, "").replace(/\s+/gu, " ").trim()
        .slice(0, DIAGNOSTIC_MAX_CHARACTERS);
      throw new ModelFacingError({
        category: "operation",
        code: "AGENT_BROWSER_FAILED",
        correction: "Не повторяйте команду автоматически. Посмотрите на страницу заново или сообщите человеку.",
        reason: `Браузер не выполнил команду ${args[0]}: ${detail || "без деталей"}`,
        retryable: false,
        sideEffectStatus: "unknown",
      });
    }
    return result.stdout;
  }

  /** `eval` prints the value JSON-encoded; a string comes back quoted. */
  const unquote = (raw: string): string => {
    const text = raw.trim();
    if (text.startsWith("\"")) { try { return JSON.parse(text) as string; } catch { return text; } }
    return text;
  };

  return {
    back: async () => { await ab("back"); },
    // `agent-browser eval` runs the script inside the page, not in this process; the scripts are
    // the fixed ones from som-script.ts, never model text.
    eval: async (script) => unquote(await ab("eval", script)),
    open: async (url) => {
      // A slow page times out the CLI's own load wait; the page is usually there anyway.
      try { await ab("open", url); } catch { /* looked at after settle */ }
    },
    press: async (key) => { await ab("press", key); },
    readText: async () => await ab("get", "text", "body"),
    screenshot: async (path) => { await ab("screenshot", path); },
    scroll: async (direction) => { await ab("scroll", direction); },
    settle: async () => {
      try { await ab("wait", "--load", "domcontentloaded"); } catch { /* bounded by the CLI timeout */ }
      await ab("wait", String(SETTLE_MS));
    },
    url: async () => (await ab("get", "url")).trim(),
  };
}
