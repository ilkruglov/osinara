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
const AGENT_BROWSER_CALL = /(?:^|[\s;&|(`])agent-browser(?=\s|$)/u;

export function refuseBrowserCommand(command: string): { exitCode: number; stderr: string; stdout: string } | null {
  if (!AGENT_BROWSER_CALL.test(command) || command.includes(`--session ${READER_SESSION}`)) return null;
  return {
    exitCode: 126,
    stderr: `${BROWSER_COMMAND_FORBIDDEN}: сессией браузера управляют только инструменты browser_open, browser_look, browser_act, browser_confirm и browser_read; подтверждение confirmation_required нельзя обойти через Bash. Для чтения публичной страницы в Bash остаётся agent-browser --session ${READER_SESSION} --engine lightpanda.`,
    stdout: "",
  };
}
