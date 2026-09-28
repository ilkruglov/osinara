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
 */
export const BROWSER_COMMAND_FORBIDDEN = "AGENT_SANDBOX_BROWSER_COMMAND_FORBIDDEN";

const READER_SESSION = "osinara-reader";
/**
 * The binary anywhere in a command, whatever quoting or path prefix surrounds it: `'agent-browser'`,
 * `/usr/local/bin/agent-browser`, `$(agent-browser …)`. A directory of that name (the skill folder
 * `.agents/skills/agent-browser/scripts/…`) is not the binary.
 */
const AGENT_BROWSER_MENTION = /(?<![\w.-])agent-browser(?=['"\s]|$)/u;
const READER_SESSION_FLAG = new RegExp(`(?:^|\\s)--session(?:=|\\s+)['"]?${READER_SESSION}['"]?(?=\\s|$)`, "u");

/** Everything a shell comment hides is invisible to the shell but not to a substring check. */
function withoutComments(command: string): string {
  return command.split("\n").map((line) => line.replace(/(?:^|\s)#.*$/u, "")).join("\n");
}

/** One simple command per element: a pipe or a list operator starts a new one with its own session flag. */
function simpleCommands(command: string): string[] {
  return withoutComments(command).split(/\n|;|&&|\|\|?|\$\(|`/u).map((part) => part.trim()).filter((part) => part.length > 0);
}

export function refuseBrowserCommand(command: string): { exitCode: number; stderr: string; stdout: string } | null {
  const offending = simpleCommands(command).some((part) => AGENT_BROWSER_MENTION.test(part) && !READER_SESSION_FLAG.test(part));
  if (!offending) return null;
  return {
    exitCode: 126,
    stderr: `${BROWSER_COMMAND_FORBIDDEN}: сессией браузера управляют только инструменты browser_open, browser_look, browser_act, browser_confirm и browser_read; подтверждение confirmation_required нельзя обойти через Bash. Для чтения публичной страницы в Bash остаётся agent-browser --session ${READER_SESSION} --engine lightpanda.`,
    stdout: "",
  };
}
