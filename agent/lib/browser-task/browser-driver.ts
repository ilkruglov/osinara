/**
 * Browser driver for browser_task: agent-browser commands inside the session sandbox.
 *
 * Export:
 * - `createSandboxBrowserDriver`: one runner process per command, session `osinara`, bounded by timeout.
 *
 * Key constructs:
 * - The loop lives in the agent process and only sends commands; the browser, its cookies and
 *   logins stay in the sandbox the model's own Bash uses (`AGENT_BROWSER_SESSION=osinara` is set
 *   there by the runner).
 * - Text leaves in shadow DOM have no ref and no selector agent-browser can find; an `eval`
 *   that walks every shadowRoot and clicks the first element carrying that exact text does.
 * - A widget in an iframe is not in the snapshot; its src opened as a page is.
 */
import type { SandboxRunnerClient } from "../sandbox-runner/runner-client.js";
import { ModelFacingError } from "../model-facing-error.js";
import { type ElementTable, parseSnapshot } from "./element-table.js";

/** `content` is the full snapshot text: headings and prose the element table leaves out. */
export interface BrowserPage { content: string; table: ElementTable; title: string; url: string; }
export interface BrowserDriver {
  click(ref: string): Promise<void>;
  clickText(text: string): Promise<void>;
  enterFrame(ref: string): Promise<void>;
  fill(ref: string, text: string): Promise<void>;
  open(url: string): Promise<void>;
  readText(): Promise<string>;
  scroll(direction: "down" | "up"): Promise<void>;
  select(ref: string, value: string): Promise<void>;
  snapshot(): Promise<BrowserPage>;
  wait(ms: number): Promise<void>;
}

const COMMAND_TIMEOUT_MS = 50_000;
const DIAGNOSTIC_MAX_CHARACTERS = 400;
const quote = (value: string): string => `'${value.replace(/'/gu, `'\\''`)}'`;

function textClickScript(text: string): string {
  return `(() => { const want = ${JSON.stringify(text)}; let hit = null;
const walk = (root) => { for (const el of root.querySelectorAll("*")) { if (hit) return; if (el.shadowRoot) walk(el.shadowRoot);
for (const n of el.childNodes) { if (n.nodeType === 3 && n.textContent.trim() === want) { const r = el.getBoundingClientRect(); if (r.width && r.height) { hit = el; return; } } } } };
walk(document); if (!hit) return "NOT_FOUND"; hit.click(); return "CLICKED"; })()`;
}

export function createSandboxBrowserDriver(input: {
  runner: Pick<SandboxRunnerClient, "run">;
  sandboxSessionId: string;
  signal?: AbortSignal;
}): BrowserDriver {
  async function ab(...args: string[]): Promise<string> {
    // The subcommand is a fixed literal; everything after it is quoted for the shell.
    const [subcommand, ...rest] = args;
    const command = `timeout --signal=TERM --kill-after=5s 45s agent-browser ${[subcommand, ...rest.map(quote)].join(" ")}`;
    const result = await input.runner.run(input.sandboxSessionId, { command, timeoutMs: COMMAND_TIMEOUT_MS }, input.signal);
    if (result.exitCode !== 0) {
      // Query strings carry tokens and booking ids; the model needs the error, not the URL.
      const detail = `${result.stderr}\n${result.stdout}`.replace(/\?[^\s'"]*/gu, "").replace(/\s+/gu, " ").trim()
        .slice(0, DIAGNOSTIC_MAX_CHARACTERS);
      throw new ModelFacingError({
        category: "operation",
        code: "AGENT_BROWSER_TASK_BROWSER_FAILED",
        correction: "Не повторяйте шаг автоматически. Сообщите пользователю, что сайт не ответил.",
        reason: `Браузер не выполнил команду ${args[0]}: ${detail || "без деталей"}`,
        retryable: false,
        sideEffectStatus: "unknown",
      });
    }
    return result.stdout;
  }

  return {
    click: async (ref) => { await ab("click", `@${ref}`); },
    async clickText(text) {
      const outcome = (await ab("eval", textClickScript(text))).trim().replace(/^"|"$/gu, "");
      if (outcome !== "CLICKED") {
        throw new ModelFacingError({
          category: "operation",
          code: "AGENT_BROWSER_TASK_TEXT_NOT_FOUND",
          correction: "Выберите другой элемент или подождите загрузку страницы.",
          reason: `На странице нет элемента с текстом ${text}`,
          retryable: false,
          sideEffectStatus: "not_started",
        });
      }
    },
    async enterFrame(ref) {
      const src = (await ab("get", "attr", `@${ref}`, "src")).trim();
      await ab("open", src);
    },
    fill: async (ref, text) => { await ab("fill", `@${ref}`, text); },
    open: async (url) => { await ab("open", url); },
    readText: async () => await ab("get", "text", "body"),
    scroll: async (direction) => { await ab("scroll", direction); },
    select: async (ref, value) => { await ab("select", `@${ref}`, value); },
    async snapshot() {
      const content = await ab("snapshot");
      return {
        content,
        table: parseSnapshot(content),
        title: (await ab("get", "title")).trim(),
        url: (await ab("get", "url")).trim(),
      };
    },
    wait: async (ms) => { await ab("wait", String(ms)); },
  };
}
