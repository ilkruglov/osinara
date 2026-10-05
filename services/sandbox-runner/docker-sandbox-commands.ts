/**
 * Shell commands the runner executes inside a sandbox container, built from untrusted paths.
 *
 * Exports:
 * - `shellQuote`: POSIX single-quote quoting; the shell expands nothing inside it.
 * - `assertShellSafePath`: control characters never reach a command or a log line.
 * - `initializeToolEnvironmentCommand`: the exact command string.
 *
 * Key construct:
 * - Every path reaches `bash -c` inside single quotes. `JSON.stringify` used to be the quoting,
 *   and its double quotes leave `$(...)` and backticks live: a file name chosen by the model in an
 *   external group could run commands in the restricted container despite the Bash denial.
 */
import { shellQuote } from "../../agent/lib/sandbox-runner/sandbox-runner-contract.js";

// oxlint-disable-next-line eslint/no-control-regex -- control characters are exactly what is rejected
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

export function assertShellSafePath(path: string): void {
  if (CONTROL_CHARACTERS.test(path)) {
    throw new Error("AGENT_SANDBOX_RUNNER_PATH_INVALID: Path contains control characters");
  }
}

export function initializeToolEnvironmentCommand(input: {
  directories: readonly string[];
  pythonRoot: string;
}): string {
  return [
    `mkdir -p ${input.directories.map(shellQuote).join(" ")}`,
    `(test -x ${shellQuote(`${input.pythonRoot}/bin/python`)} || python3 -m venv ${shellQuote(input.pythonRoot)})`,
  ].join(" && ");
}
