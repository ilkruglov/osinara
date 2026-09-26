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
 * - A command that ran out of time is `AGENT_BROWSER_TIMEOUT`, whether the CLI bound (exit 124) or
 *   the runner reported it; `open` tolerates it because the page is usually there anyway.
 */
import { dirname } from "node:path";

import { ModelFacingError } from "../model-facing-error.js";
import type { SandboxRunnerClient } from "../sandbox-runner/runner-client.js";

export interface BrowserDriver {
  back(): Promise<void>;
  eval(script: string): Promise<string>;
  open(url: string): Promise<void>;
  press(key: string): Promise<void>;
  screenshot(path: string): Promise<void>;
  scroll(direction: "down" | "up"): Promise<void>;
  settle(): Promise<void>;
  url(): Promise<string>;
}

/** The CLI bound fires first so the runner's own limit (50 s) is never the one that reports. */
const CLI_TIMEOUT_SECONDS = 40;
const CLI_KILL_AFTER_SECONDS = 3;
const COMMAND_TIMEOUT_MS = 50_000;
const SETTLE_MS = 400;
const DIAGNOSTIC_MAX_CHARACTERS = 400;
/** `timeout(1)` exit status; the runner's marker is in `services/sandbox-runner/docker-sandbox-process.ts`. */
const TIMEOUT_EXIT_CODE = 124;
const RUNNER_TIMED_OUT = /AGENT_SANDBOX_RUNNER_PROCESS_TIMED_OUT|time(d )?out/iu;
const quote = (value: string): string => `'${value.replace(/'/gu, `'\\''`)}'`;

export function createSandboxBrowserDriver(input: {
  runner: Pick<SandboxRunnerClient, "run">;
  sandboxSessionId: string;
  signal?: AbortSignal;
}): BrowserDriver {
  const browserCommand = (args: string[]): string => {
    const [subcommand, ...rest] = args;
    return `timeout --signal=TERM --kill-after=${CLI_KILL_AFTER_SECONDS}s ${CLI_TIMEOUT_SECONDS}s agent-browser ${[subcommand, ...rest.map(quote)].join(" ")}`;
  };

  async function exec(command: string, name: string): Promise<string> {
    const result = await input.runner.run(input.sandboxSessionId, { command, timeoutMs: COMMAND_TIMEOUT_MS }, input.signal);
    if (result.exitCode === 0) return result.stdout;
    // Query strings carry tokens and booking ids; the model needs the error, not the URL.
    const detail = `${result.stderr}\n${result.stdout}`.replace(/\?[^\s'"]*/gu, "").replace(/\s+/gu, " ").trim()
      .slice(0, DIAGNOSTIC_MAX_CHARACTERS);
    const timedOut = result.exitCode === TIMEOUT_EXIT_CODE || RUNNER_TIMED_OUT.test(detail);
    throw new ModelFacingError({
      category: "operation",
      code: timedOut ? "AGENT_BROWSER_TIMEOUT" : "AGENT_BROWSER_FAILED",
      correction: timedOut
        ? "Не повторяйте команду автоматически: страница могла загрузиться. Посмотрите на неё через browser_look или сообщите человеку."
        : "Не повторяйте команду автоматически. Посмотрите на страницу заново или сообщите человеку.",
      reason: timedOut
        ? `Браузер не ответил за ${CLI_TIMEOUT_SECONDS} с на команду ${name}`
        : `Браузер не выполнил команду ${name}: ${detail || "без деталей"}`,
      retryable: false,
      sideEffectStatus: "unknown",
    });
  }

  const ab = (...args: string[]): Promise<string> => exec(browserCommand(args), args[0]!);

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
      // A slow page runs out the load wait; the page is usually there anyway. Any other failure
      // (no daemon, no runner) is reported: the old tab must not pass for the new address.
      try { await ab("open", url); } catch (error) {
        if (!(error instanceof ModelFacingError && error.code === "AGENT_BROWSER_TIMEOUT")) throw error;
      }
    },
    press: async (key) => { await ab("press", key); },
    // The shots directory does not exist in a fresh workspace: 26 September 2026 every look of a
    // login attempt lost its screenshot to "No such file or directory".
    screenshot: async (path) => { await exec(`mkdir -p ${quote(dirname(path))} && ${browserCommand(["screenshot", path])}`, "screenshot"); },
    scroll: async (direction) => { await ab("scroll", direction); },
    settle: async () => {
      try { await ab("wait", "--load", "domcontentloaded"); } catch { /* bounded by the CLI timeout */ }
      await ab("wait", String(SETTLE_MS));
    },
    url: async () => (await ab("get", "url")).trim(),
  };
}
