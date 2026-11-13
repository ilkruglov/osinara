/**
 * Tool calls that would reach the model without a result.
 *
 * Exports:
 * - `repairOrphanedToolCalls`: answers each call of the prompt history that has no result anywhere,
 *   right after its assistant message, with an error that says the outcome is unknown.
 * - `logRepair`: logs a repair (`AGENT_TOOL_HISTORY_REPAIRED`) once per session and set of calls;
 *   the prompt is repaired on every step until the call leaves the history.
 * - `splitParkedResponse`: the response of a step that parks on an approval, split into the results
 *   of work resumed at its start (committed to the history) and the rest (kept with the batch).
 *
 * Key constructs (ported from Eve 1.0, f5b36b3 and 4264f03, 13 November 2026):
 * - The AI SDK rejects a prompt in which a local tool call has no result before the next user
 *   message (`MissingToolResultsError`), and the turn fails; in our 0.40 the channel then rotates
 *   the session and the context is lost. A repair here only touches calls the SDK would reject, so
 *   it never turns a working history into a different one: the calls are answered, never run.
 * - Left alone, as in Eve 1.0: provider-executed calls, calls with a result anywhere (even
 *   misplaced: it belongs to its history), calls with an approval request or response (work the
 *   approval still owns), and duplicate call ids.
 * - Eve 1.0 also answers the calls of a step cut short at the output limit (43f585c): its AI SDK
 *   runs tools only on `stop`/`tool-calls`. Ours (7.0.60) runs every complete client call whatever
 *   the finish reason (`generateText` and `streamText` alike), so there is nothing to answer here.
 * - A step resumed after one approval runs the approved tool, then the model may ask for a second
 *   approval. Parking kept the whole response with the new batch, so the first tool's result never
 *   reached the history and the next resume ran that tool again (Eve 1.0 4264f03): the leading
 *   tool messages are committed ahead of the pending-approval note.
 */

interface ContentPart {
  approvalId?: string;
  providerExecuted?: boolean;
  toolCall?: { toolCallId?: string };
  toolCallId?: string;
  toolName?: string;
  type?: string;
}

interface Message {
  content: unknown;
  role: string;
}

const UNKNOWN_OUTCOME =
  "Прошлая попытка закончилась без записанного результата, исход неизвестен. Прежде чем повторять действие с побочным эффектом, проверь, что уже сделано.";

function partsOf(message: Message): ContentPart[] {
  return Array.isArray(message.content) ? (message.content as ContentPart[]) : [];
}

function approvalCallId(part: ContentPart): string | undefined {
  return part.toolCall?.toolCallId ?? part.toolCallId;
}

export function repairOrphanedToolCalls(messages: readonly Message[]): {
  messages: readonly Message[];
  repaired: string[];
} {
  const protectedIds = new Set<string>();
  const approvalIds = new Map<string, string>();
  const responses: ContentPart[] = [];
  const seen = new Set<string>();
  for (const message of messages)
    for (const part of partsOf(message)) {
      if (part.type === "tool-result" && part.toolCallId) protectedIds.add(part.toolCallId);
      if (part.type === "tool-approval-response") responses.push(part);
      if (part.type === "tool-approval-request") {
        const id = approvalCallId(part);
        if (id) protectedIds.add(id);
        if (id && part.approvalId) approvalIds.set(part.approvalId, id);
      }
      if (part.type !== "tool-call" || !part.toolCallId) continue;
      if (seen.has(part.toolCallId) || part.providerExecuted === true)
        protectedIds.add(part.toolCallId);
      seen.add(part.toolCallId);
    }
  // A response without its request in the prompt still settles the call, as the SDK reads it.
  for (const part of responses) {
    const id = (part.approvalId && approvalIds.get(part.approvalId)) ?? approvalCallId(part);
    if (id) protectedIds.add(id);
  }

  const repaired: string[] = [];
  const out: Message[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    out.push(message);
    if (message.role !== "assistant") continue;
    const answers = partsOf(message).flatMap((part) =>
      part.type === "tool-call" && part.toolCallId && !protectedIds.has(part.toolCallId)
        ? [
            {
              output: { type: "error-text", value: UNKNOWN_OUTCOME },
              toolCallId: part.toolCallId,
              toolName: part.toolName ?? "",
              type: "tool-result",
            },
          ]
        : [],
    );
    if (answers.length === 0) continue;
    repaired.push(...answers.map((answer) => answer.toolCallId));
    const next = messages[index + 1];
    if (next?.role === "tool" && Array.isArray(next.content)) {
      out.push({ ...next, content: [...next.content, ...answers] });
      index += 1;
    } else {
      out.push({ content: answers, role: "tool" });
    }
  }
  return repaired.length === 0 ? { messages, repaired } : { messages: out, repaired };
}

const LOGGED_REPAIRS_MAX = 1_000;
const loggedRepairs = new Map<string, string>();

/** Logs a repair the first time a session shows this set of calls; bounded, oldest forgotten. */
export function logRepair(sessionId: string, toolCallIds: readonly string[]): void {
  const key = toolCallIds.join(",");
  if (toolCallIds.length === 0 || loggedRepairs.get(sessionId) === key) return;
  loggedRepairs.delete(sessionId);
  loggedRepairs.set(sessionId, key);
  if (loggedRepairs.size > LOGGED_REPAIRS_MAX)
    loggedRepairs.delete(loggedRepairs.keys().next().value!);
  console.error(JSON.stringify({ code: "AGENT_TOOL_HISTORY_REPAIRED", sessionId, toolCallIds }));
}

export function splitParkedResponse<M extends Message>(
  responseMessages: readonly M[],
): { committed: M[]; pending: M[] } {
  const start = responseMessages.findIndex((message) => message.role !== "tool");
  const end = start === -1 ? responseMessages.length : start;
  return { committed: responseMessages.slice(0, end), pending: responseMessages.slice(end) };
}
