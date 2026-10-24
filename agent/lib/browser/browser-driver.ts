/**
 * The browser of one trust zone, driven through `agent-browser` in the zone's sandbox.
 *
 * Exports:
 * - `BrowserDriver`: open, eval, screenshot, text, key press, scroll, back, settle, url.
 * - `createSandboxBrowserDriver`: production driver over the sandbox runner.
 * - `isBrowserRestarted`, `browserRestartedError`: the error of a browser the driver had to restart.
 *
 * Key constructs:
 * - Every call is one bounded `agent-browser` process in the session's browser companion container
 *   (runner target `browser`), apart from the model's Bash; the CLI keeps one Chromium per session
 *   (`osinara`), so cookies and logins outlive a task.
 * - No element refs: the page is marked and acted on through `som-script.ts`, so the driver only
 *   evaluates scripts and never has to know which number is which.
 * - `settle()` waits for a navigation to land before the next look, bounded so a page that never
 *   settles (analytics, long polling) cannot hold a step.
 * - A command that ran out of time is `AGENT_BROWSER_TIMEOUT`, whether the CLI bound (exit 124) or
 *   the runner reported it; `open` tolerates it because the page is usually there anyway.
 * - A command that ran past the CLI or runner bound may mean the daemon itself hangs: a page that
 *   never finishes loading (taxi.yandex.ru sent the tab to yandex.ru, then dzen.ru) left every later
 *   command of the session waiting until the container was replaced (live run, 24 October 2026).
 *   The driver then asks the daemon for the URL with a short bound; if that times out too, it kills
 *   the daemon and Chrome in the companion. The next command starts a fresh daemon that restores the
 *   saved logins (cookies, localStorage), and the command reports `AGENT_BROWSER_RESTARTED`: the open
 *   page is gone, unlike a slow page. agent-browser's own timeout (exit 1) proves the daemon answers
 *   and never leads to a restart.
 */
import { randomUUID } from "node:crypto";

import { ModelFacingError } from "../model-facing-error.js";
import { noteBrowserRestart } from "./browser-restarts.js";
import type { SandboxRunnerClient } from "../sandbox-runner/runner-client.js";
import { shellQuote } from "../sandbox-runner/sandbox-runner-contract.js";

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
/** `timeout(1)` after KILL: the probe's own signal, or an uncooperative CLI at the kill-after boundary. */
const KILLED_EXIT_CODE = 137;
const RUNNER_TIMED_OUT = /AGENT_SANDBOX_RUNNER_PROCESS_TIMED_OUT|time(d )?out/iu;
const RUNNER_BOUND = /AGENT_SANDBOX_RUNNER_PROCESS_TIMED_OUT/u;
/** Long enough for a responsive daemon, short enough not to double a hung command's wait. */
const PROBE_TIMEOUT_SECONDS = 10;
const RECOVERY_RUNNER_TIMEOUT_MS = 20_000;
/**
 * Kills the companion's daemon (and any CLI waiting on it) and its Chrome; the daemon's socket and
 * pid file go too, so the next command starts a fresh one. The bracketed patterns and the `?` glob
 * keep this command's own text from matching itself: pkill -f also sees the shell running it.
 */
const BROWSER_RESET_COMMAND = [
  "pkill -KILL -f '[a]gent-browser'",
  "pkill -KILL -f '[c]hrome'",
  "rm -f \"$HOME\"/.agent?browser/*.sock \"$HOME\"/.agent?browser/*.pid",
  "exit 0",
].join("; ");

export const isBrowserRestarted = (error: unknown): boolean =>
  error instanceof ModelFacingError && error.code === "AGENT_BROWSER_RESTARTED";

export function browserRestartedError(name: string): ModelFacingError {
  return new ModelFacingError({
    category: "operation",
    code: "AGENT_BROWSER_RESTARTED",
    correction: "Откройте нужную страницу заново (browser_open) и посмотрите на неё; действие на странице вслепую не повторяйте.",
    reason: `Браузер завис на команде ${name} и перезапущен: входы в сайты сохранены, открытая страница закрылась`,
    retryable: false,
    sideEffectStatus: "unknown",
  });
}

export function createSandboxBrowserDriver(input: {
  /** After a restart: forget what was known about the closed page (the saved look). */
  onRestart?: () => Promise<void>;
  runner: Pick<SandboxRunnerClient, "run" | "writeFile">;
  sandboxSessionId: string;
  signal?: AbortSignal;
}): BrowserDriver {
  const browserCommand = (args: string[]): string => {
    const [subcommand, ...rest] = args;
    return `timeout --signal=TERM --kill-after=${CLI_KILL_AFTER_SECONDS}s ${CLI_TIMEOUT_SECONDS}s agent-browser ${[subcommand, ...rest.map(shellQuote)].join(" ")}`;
  };

  // The browser companion of the session, never the container of the model's Bash: there the
  // logged-in browser could be driven past the confirmation gate (security review, 5 October 2026).
  const run = (command: string, timeoutMs: number) => input.runner.run(input.sandboxSessionId, { command, target: "browser", timeoutMs }, input.signal);
  const ranPastBound = (result: { exitCode: number; stderr: string; stdout: string }) =>
    result.exitCode === TIMEOUT_EXIT_CODE || result.exitCode === KILLED_EXIT_CODE || RUNNER_BOUND.test(`${result.stderr}\n${result.stdout}`);

  /** After a command ran past its bound: true when the daemon was hung and has been killed. */
  async function restartIfHung(name: string): Promise<boolean> {
    try {
      const probe = await run(`timeout --signal=KILL ${PROBE_TIMEOUT_SECONDS}s agent-browser get url`, RECOVERY_RUNNER_TIMEOUT_MS);
      if (!ranPastBound(probe)) return false;
      const reset = await run(BROWSER_RESET_COMMAND, RECOVERY_RUNNER_TIMEOUT_MS);
      console.error(JSON.stringify({ code: "AGENT_BROWSER_DAEMON_RESET", command: name, exitCode: reset.exitCode }));
      if (reset.exitCode !== 0) return false;
      noteBrowserRestart(input.sandboxSessionId);
      // Readers already ignore looks older than this restart; a failed cleanup is only logged.
      await input.onRestart?.().catch(() => {
        console.error(JSON.stringify({ code: "AGENT_BROWSER_LOOK_RESET_FAILED" }));
      });
      return true;
    } catch {
      // The original timeout is what the caller needs to hear; a failed recovery must not hide it.
      return false;
    }
  }

  async function exec(command: string, name: string): Promise<string> {
    const result = await run(command, COMMAND_TIMEOUT_MS);
    if (result.exitCode === 0) return result.stdout;
    // Query strings carry tokens and booking ids; the model needs the error, not the URL.
    const detail = `${result.stderr}\n${result.stdout}`.replace(/\?[^\s'"]*/gu, "").replace(/\s+/gu, " ").trim()
      .slice(0, DIAGNOSTIC_MAX_CHARACTERS);
    const timedOut = result.exitCode === TIMEOUT_EXIT_CODE || RUNNER_TIMED_OUT.test(detail);
    if (ranPastBound(result) && await restartIfHung(name)) throw browserRestartedError(name);
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
    // The companion has no workspace: it shoots into its own /tmp and prints the image, and the
    // bytes reach the workspace through the session's own container (which creates the shots
    // folder). A link planted in that folder by Bash then leads nowhere but Bash's own files;
    // with the workspace mounted in the companion it led into the browser's private state
    // (Codex review, 5 October 2026).
    screenshot: async (path) => {
      const staging = shellQuote(`/tmp/osinara-shot-${randomUUID()}.png`);
      const encoded = await exec(
        `${browserCommand(["screenshot", staging.slice(1, -1)])} >&2 && base64 -w0 ${staging}; status=$?; rm -f ${staging}; exit $status`,
        "screenshot",
      );
      const bytes = Buffer.from(encoded.trim(), "base64");
      if (bytes.length === 0) {
        throw new ModelFacingError({
          category: "operation",
          code: "AGENT_BROWSER_FAILED",
          correction: "Не повторяйте команду автоматически. Посмотрите на страницу заново или сообщите человеку.",
          reason: "Браузер не вернул снимок экрана",
          retryable: false,
          sideEffectStatus: "unknown",
        });
      }
      await input.runner.writeFile(input.sandboxSessionId, path, bytes, input.signal);
    },
    scroll: async (direction) => { await ab("scroll", direction); },
    settle: async () => {
      try { await ab("wait", "--load", "domcontentloaded"); } catch (error) {
        // Bounded by the CLI timeout; a restarted browser lost the page, which the caller must hear.
        if (isBrowserRestarted(error)) throw error;
      }
      await ab("wait", String(SETTLE_MS));
    },
    url: async () => (await ab("get", "url")).trim(),
  };
}
