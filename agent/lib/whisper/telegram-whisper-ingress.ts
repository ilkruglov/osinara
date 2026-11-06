/**
 * Durable ingress of an ephemeral message.
 *
 * Export:
 * - `acceptTelegramEphemeralMessage`: queues an accepted whisper in its own lane, drops the rest.
 *
 * Key constructs:
 * - An ephemeral message has `message_id` 0, and the group journal and queue are keyed by message
 *   and chat, so nothing ephemeral may reach them: a whisper goes to the lane of its chat and
 *   author, and every other ephemeral message is acknowledged and forgotten.
 * - The stored update carries the placeholder the gate sent (and recorded). Telegram redelivers an
 *   update it got no answer for, and the redelivery gets a placeholder of its own; the update is
 *   already queued with the first one, so the repository reports a conflict and the new placeholder
 *   is removed.
 * - A write that failed keeps its placeholder: it may have committed. If it did not (a rollback, a
 *   process that died after the placeholder was sent), no stored update carries the placeholder,
 *   and the minute sweep removes it (`whisper-placeholder-sweep.ts`).
 */
import type { TelegramMessage } from "eve/channels/telegram";

import { isAppError } from "../app-error.js";
import type { TelegramIngressRepository } from "../telegram-ingress-contract.js";
import type { TelegramWhisperGate } from "./telegram-whisper-gate.js";
import { telegramWhisperQueueKey, withTelegramWhisperMarker } from "./telegram-whisper.js";

export async function acceptTelegramEphemeralMessage(input: {
  enqueue: TelegramIngressRepository["enqueue"];
  gate: TelegramWhisperGate | undefined;
  message: TelegramMessage;
  raw: Record<string, unknown>;
  updateId: string;
}): Promise<"dropped" | "queued"> {
  const marker = input.gate ? await input.gate.open(input.message, input.updateId) : null;
  if (!marker) return "dropped";
  try {
    const status = await input.enqueue({
      continuationKey: telegramWhisperQueueKey(input.message.chat.id, marker.receiverUserId),
      payload: withTelegramWhisperMarker(input.raw, marker),
      updateId: input.updateId,
    });
    if (status === "inserted") return "queued";
  } catch (error) {
    // Any other failure may have committed before its answer was lost: the stored update would
    // then need this very placeholder, so it stays; the sweep removes it if nothing was stored.
    // Telegram retries the webhook either way.
    if (!isAppError(error) || error.code !== "AGENT_TELEGRAM_UPDATE_CONFLICT") throw error;
  }
  // The same update is already queued with the placeholder of its first delivery.
  await input.gate!.close(input.message.chat.id, marker);
  return "dropped";
}
