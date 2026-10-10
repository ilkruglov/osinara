/**
 * Telegram `message_reaction` updates: parsing and the webhook handler that records them.
 *
 * Exports:
 * - `parseTelegramReactionUpdate`: the chat, message, person, emojis and time of a reaction
 *   update; null for any other update, for an anonymous (channel) reactor, or for a malformed one.
 * - `handleTelegramUnparsedUpdate`: records a reaction and answers Telegram `ok` either way; the
 *   webhook must never fail over bookkeeping.
 *
 * Key constructs:
 * - Telegram sends these only when the bot is an administrator of the chat and the webhook
 *   subscribes to `message_reaction`; a custom emoji is kept as `custom:<id>` and counts as "other".
 * - Nothing is dispatched to Eve: a reaction is a measurement, not a message.
 */
import { turnEvaluationRepository } from "./turn-evaluation-repository.js";

export interface TelegramReactionUpdate {
  changedAt: Date;
  emojis: string[];
  telegramChatId: string;
  telegramMessageId: string;
  telegramUserId: string;
  /** Orders two changes within the same second (Telegram dates are whole seconds). */
  updateId: string;
}

const MAX_EMOJIS = 16;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idText(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value)
    : typeof value === "string" && /^-?\d{1,20}$/u.test(value) ? value : null;
}

function reactionEmoji(value: unknown): string | null {
  if (!isObject(value)) return null;
  if (value.type === "emoji" && typeof value.emoji === "string" && value.emoji.length > 0) return value.emoji.replace(/\uFE0F/gu, "");
  if (value.type === "custom_emoji" && typeof value.custom_emoji_id === "string") return `custom:${value.custom_emoji_id}`;
  if (value.type === "paid") return "paid";
  return null;
}

export function parseTelegramReactionUpdate(raw: unknown): TelegramReactionUpdate | null {
  if (!isObject(raw) || !isObject(raw.message_reaction)) return null;
  const updateId = idText(raw.update_id);
  const reaction = raw.message_reaction;
  const chatId = isObject(reaction.chat) ? idText(reaction.chat.id) : null;
  const messageId = idText(reaction.message_id);
  // A reaction by an anonymous channel identity has no person behind it to measure.
  const userId = isObject(reaction.user) ? idText(reaction.user.id) : null;
  if (updateId === null || chatId === null || messageId === null || userId === null || !Array.isArray(reaction.new_reaction)) return null;
  const changedAt = typeof reaction.date === "number" ? new Date(reaction.date * 1000) : null;
  if (changedAt === null || Number.isNaN(changedAt.getTime())) return null;
  const emojis = reaction.new_reaction.slice(0, MAX_EMOJIS).map(reactionEmoji).filter((emoji): emoji is string => emoji !== null);
  return { changedAt, emojis, telegramChatId: chatId, telegramMessageId: messageId, telegramUserId: userId, updateId };
}

export async function handleTelegramUnparsedUpdate(
  raw: unknown,
  record: (update: TelegramReactionUpdate) => Promise<void> = (update) => turnEvaluationRepository.recordReaction(update),
): Promise<Response> {
  const update = parseTelegramReactionUpdate(raw);
  if (update === null) return new Response("ok");
  try {
    await record(update);
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_TELEGRAM_REACTION_RECORD_FAILED",
      error: error instanceof Error ? error.message : String(error),
      telegramChatId: update.telegramChatId,
    }));
  }
  return new Response("ok");
}
