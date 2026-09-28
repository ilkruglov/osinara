/**
 * Bash must not drive the Chromium session the browser tools own.
 *
 * Exports:
 * - `refuseBrowserCommand`: the refusal result for a Bash command that would touch that session,
 *   or `null` when the command may run.
 * - `BROWSER_COMMAND_FORBIDDEN`: the stable code in that refusal.
 *
 * Key constructs:
 * - The gates of `browser_act` (`agent/lib/browser/gate.ts`) only hold while nothing else can click
 *   in the same Chromium. On 26 September 2026 the model answered a `confirmation_required` on a
 *   login form by clicking and typing the phone number with raw `agent-browser` in Bash.
 * - The reader session (`osinara-reader`, Lightpanda: no cookies, no logins, no screenshots)
 *   stays available to Bash, as does the cloud helper script, which owns a separate session.
 * - A string check, not a shell parser (two Codex reviews, 28 September 2026): quotes and escapes
 *   are dropped first, every call must carry the reader flag right after the binary, nested shells
 *   and names assembled from variables are refused. The real boundary would be a separate uid for
 *   the tools' Chromium; until then this stops the model's honest mistakes and obvious tricks.
 */
export const BROWSER_COMMAND_FORBIDDEN = "AGENT_SANDBOX_BROWSER_COMMAND_FORBIDDEN";

const READER_SESSION = "osinara-reader";

/**
 * The command as the shell will mostly see it: line continuations joined, quotes and backslashes
 * dropped, so `agent\-browser`, `agent-""browser` and `'--session'` read as what they run.
 */
function normalized(command: string): string {
  return command.replace(/\\\r?\n/gu, " ").replace(/['"\\]/gu, "");
}

/** The binary as a word (a path prefix allowed); a directory of that name (`…/agent-browser/scripts`) is not it. */
const AGENT_BROWSER_WORD = /(?<![\w.-])agent-browser(?![\w/.-])/gu;
/** Every call must name the reader session right after the binary; a flag elsewhere in the line proves nothing. */
const READER_RIGHT_AFTER = new RegExp(`^\\s+--session(?:=|\\s+)${READER_SESSION}(?=\\s|$|[;&|)])`, "u");
/** A nested shell, eval or xargs decides itself which words reach the binary. */
const WRAPPER = /(?:^|[\s;&|(`])(?:(?:ba|z|da)?sh\s+(?:-\w*\s+)*-\w*c|eval|exec|xargs|source|env\s+-\w*S)(?=\s|$)/u;
/** A name assembled from variables or globs cannot be read by a string check at all. */
const ASSEMBLED = /[$*?[{][^\s;&|]{0,12}brows|brows[^\s;&|]{0,12}[$*?\]{}]|agent-[^\s;&|]{0,6}[$*?[{]/u;

function drivesToolSession(command: string): boolean {
  const text = normalized(command).replace(/(?:^|\s)#[^\n]*/gu, " ");
  if (ASSEMBLED.test(text)) return true;
  const calls = [...text.matchAll(AGENT_BROWSER_WORD)];
  if (calls.length === 0) return false;
  if (WRAPPER.test(text)) return true;
  return calls.some((call) => !READER_RIGHT_AFTER.test(text.slice(call.index + call[0].length)));
}

export function refuseBrowserCommand(command: string): { exitCode: number; stderr: string; stdout: string } | null {
  if (!drivesToolSession(command)) return null;
  return {
    exitCode: 126,
    stderr: `${BROWSER_COMMAND_FORBIDDEN}: сессией браузера управляют только инструменты browser_open, browser_look, browser_act, browser_confirm и browser_read; подтверждение confirmation_required нельзя обойти через Bash. Для чтения публичной страницы в Bash остаётся agent-browser --session ${READER_SESSION} --engine lightpanda.`,
    stdout: "",
  };
}
