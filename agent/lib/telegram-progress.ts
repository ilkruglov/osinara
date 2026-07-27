/**
 * Telegram delivery policy for completed model messages.
 *
 * Exports:
 * - `completedTelegramMessage`: keeps meaningful terminal model text and hides pre-tool steps.
 *
 * MiniMax reasoning is separated by `minimax-model.ts`; Eve routes reasoning parts
 * to dedicated events that this delivery policy never receives.
 */
const TOOL_CALLS_FINISH_REASON = "tool-calls";

export function completedTelegramMessage(data: {
  finishReason: string;
  message?: string | null;
}): string | null {
  // Telegram has no safe ephemeral progress surface here; pre-tool text can be model noise.
  if (data.finishReason === TOOL_CALLS_FINISH_REASON) return null;

  // Only completed visible assistant text should become a durable Telegram message.
  const message =
    data.message === undefined || data.message === null ? "" : data.message.trim();
  return message ? message : null;
}
