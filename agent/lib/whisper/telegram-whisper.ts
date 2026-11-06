/**
 * Telegram `/whisper`: a question to Mia in a group that only its author and the bot see.
 *
 * Exports:
 * - `TELEGRAM_WHISPER_BOT_COMMAND`: the ephemeral command declared for all group chats.
 * - `parseTelegramWhisperCommand`: an ephemeral `/whisper` from a person in a group, or null.
 * - `isTelegramEphemeralMessage`: any message Telegram shows to one person only.
 * - `withTelegramWhisperMarker` / `readTelegramWhisperMarker`: the placeholder the ingress sent,
 *   carried in the stored update to the turn.
 * - `telegramWhisperQueueKey`, `telegramWhisperContinuationToken`: the whisper's own FIFO and session.
 * - `TELEGRAM_WHISPER_ATTRIBUTE` and friends, `isTelegramWhisperSession`: verified turn attributes.
 *
 * Key constructs:
 * - Bot API (ephemeral messages): an ephemeral command is seen by its sender and the bot only; its
 *   message has `message_id` 0 and an `ephemeral_message_id`. The group journal, the group queue
 *   and the group session are keyed by message and chat, so a whisper never enters any of them.
 * - A reply to an ephemeral message is possible only within 15 seconds of it (unless the bot is a
 *   chat administrator), so the ingress answers with a placeholder at once and the turn edits it.
 */
import type { SessionAuth } from "eve/context";
import type { TelegramMessage } from "eve/channels/telegram";

export const TELEGRAM_WHISPER_COMMAND = "whisper";

export const TELEGRAM_WHISPER_BOT_COMMAND = {
  command: TELEGRAM_WHISPER_COMMAND,
  description: "Спросить Мию так, что вопрос и ответ увидите только вы",
  is_ephemeral: true,
} as const;

export const TELEGRAM_WHISPER_ATTRIBUTE = "telegramWhisper";
export const TELEGRAM_WHISPER_PLACEHOLDER_ATTRIBUTE = "telegramWhisperPlaceholderId";
export const TELEGRAM_WHISPER_RECEIVER_ATTRIBUTE = "telegramWhisperReceiverId";

const TELEGRAM_WHISPER_MARKER_KEY = "osinara_whisper";
const WHISPER_PATTERN = /^\/whisper(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/iu;
const GROUP_CHAT_TYPES = new Set(["group", "supergroup"]);

export interface TelegramWhisperCommand {
  readonly ephemeralMessageId: number;
  readonly question: string;
  readonly receiverUserId: string;
}

export interface TelegramWhisperMarker {
  readonly ephemeralMessageId: number;
  readonly placeholderMessageId: number;
  readonly receiverUserId: string;
}

function positiveId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function isTelegramEphemeralMessage(raw: Record<string, unknown>): boolean {
  return raw.ephemeral_message_id !== undefined && raw.ephemeral_message_id !== null;
}

export function parseTelegramWhisperCommand(
  message: TelegramMessage,
  botUsername: string,
): TelegramWhisperCommand | null {
  if (!GROUP_CHAT_TYPES.has(message.chat.type)) return null;
  if (!message.from || message.from.isBot) return null;
  const ephemeralMessageId = positiveId(message.raw.ephemeral_message_id);
  if (ephemeralMessageId === null) return null;
  const match = WHISPER_PATTERN.exec(message.text.trim());
  if (!match) return null;
  const addressedBot = match[1];
  if (addressedBot !== undefined && addressedBot.toLowerCase() !== botUsername.toLowerCase()) return null;
  return {
    ephemeralMessageId,
    question: (match[2] ?? "").trim(),
    receiverUserId: message.from.id,
  };
}

/** The stored update carries the placeholder; the incoming payload itself is never changed. */
export function withTelegramWhisperMarker(
  payload: Record<string, unknown>,
  marker: TelegramWhisperMarker,
): Record<string, unknown> {
  const message = payload.message as Record<string, unknown>;
  return { ...payload, message: { ...message, [TELEGRAM_WHISPER_MARKER_KEY]: { ...marker } } };
}

export function readTelegramWhisperMarker(raw: Record<string, unknown>): TelegramWhisperMarker | null {
  const value = raw[TELEGRAM_WHISPER_MARKER_KEY];
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const ephemeralMessageId = positiveId(candidate.ephemeralMessageId);
  const placeholderMessageId = positiveId(candidate.placeholderMessageId);
  const receiverUserId = candidate.receiverUserId;
  if (ephemeralMessageId === null || placeholderMessageId === null ||
    typeof receiverUserId !== "string" || !/^[1-9]\d*$/u.test(receiverUserId)) return null;
  return { ephemeralMessageId, placeholderMessageId, receiverUserId };
}

/** One FIFO per chat and person: a whisper never waits behind the group's own turns. */
export function telegramWhisperQueueKey(chatId: string, telegramUserId: string): string {
  return `telegram:whisper:${chatId}:${telegramUserId}`;
}

/** The route of a person's whispers in a group topic; never the group's own session route. */
export function telegramWhisperContinuationToken(
  groupId: string,
  telegramForumTopicId: number | null,
  telegramUserId: string,
): string {
  const topic = telegramForumTopicId === null ? "main" : `topic:${telegramForumTopicId}`;
  return `osinara:whisper:${groupId}:${topic}:${telegramUserId}`;
}

export function isTelegramWhisperSession(auth: Pick<SessionAuth, "current">): boolean {
  return auth.current?.attributes[TELEGRAM_WHISPER_ATTRIBUTE] === "true";
}
