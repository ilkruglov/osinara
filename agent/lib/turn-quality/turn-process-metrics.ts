/**
 * Process metrics of one turn, computed from the recorded tool calls without a model.
 *
 * Export:
 * - `turnProcessMetrics`: the longest run of identical consecutive calls (a loop), whether a call
 *   was repeated unchanged after it failed, and whether a forbidden tool was called.
 *
 * Key construct:
 * - A call is identified by tool name and the hash of its input: the same pair twice in a row is
 *   a repeat, a changed input is a retry with progress. The step counter cannot tell these apart.
 */
export interface TurnToolCall {
  /** Failure code of the call, null when it succeeded. */
  code: string | null;
  inputHash: string;
  toolName: string;
}

export interface TurnProcessMetrics {
  forbiddenTool: boolean;
  repeatAfterError: boolean;
  repeatedCallRun: number;
}

const FORBIDDEN_TOOL_CODES = new Set(["AGENT_GROUP_TOOL_FORBIDDEN", "AGENT_TOOL_FORBIDDEN"]);

const key = (call: TurnToolCall) => `${call.toolName}\u0000${call.inputHash}`;

export function turnProcessMetrics(calls: readonly TurnToolCall[]): TurnProcessMetrics {
  let repeatedCallRun = 0;
  let run = 0;
  let previous: string | null = null;
  let repeatAfterError = false;
  const failed = new Set<string>();
  for (const call of calls) {
    const current = key(call);
    run = current === previous ? run + 1 : 1;
    previous = current;
    if (run > repeatedCallRun) repeatedCallRun = run;
    if (failed.has(current)) repeatAfterError = true;
    if (call.code !== null) failed.add(current);
    else failed.delete(current);
  }
  return {
    forbiddenTool: calls.some((call) => call.code !== null && FORBIDDEN_TOOL_CODES.has(call.code)),
    repeatAfterError,
    repeatedCallRun,
  };
}
