/**
 * Consecutive messages of one author, answered in one turn.
 *
 * A person or another bot often splits one thought into several Telegram messages. The durable
 * ingress claims such a run from the head of a chat queue and dispatches every message through the
 * ordinary handler so the journal keeps its order; only the last message starts a model turn, and
 * it names the earlier sequences so one answer covers the whole run.
 *
 * Exports:
 * - `TELEGRAM_SERIES_MAX_MESSAGES`: bound on messages answered by one turn.
 * - `TelegramSeriesMarker`: application marker carried in the raw message (`context` or `current`).
 * - `isSeriesEligible`: message shapes that may join a series at all.
 * - `continuesSeries`: whether a candidate extends the series started by the head message.
 * - `withSeriesMarker`, `readTelegramSeriesMarker`: marker transport through Eve's parsed update.
 * - `withSeriesAddressed`, `wasAddressedInSeries`: the address a series keeps in the queue, carried
 *   to the turn of a member that comes back alone.
 */
import type { TelegramMessage, TelegramUpdate } from "eve/channels/telegram";

import {
  classifyTelegramInboundMedia,
  isReplyToBot,
  isTelegramForward,
  isTelegramSlashCommand,
  mentionsAnotherUsername,
  telegramMessageText,
} from "./telegram-message-policy.js";

export const TELEGRAM_SERIES_MAX_MESSAGES = 10;
export const TELEGRAM_SERIES_MARKER_KEY = "osinara_series";
/**
 * A member of a series that called Mia keeps the address in the queue (`series_addressed`,
 * 26 November 2026): one a failure or a restart returns there comes back without the caption that
 * called her, and must still be answered. The drain sets this key at dispatch; it is never stored.
 */
const TELEGRAM_SERIES_ADDRESSED_KEY = "osinara_series_addressed";

export function withSeriesAddressed(
  update: TelegramUpdate & { kind: "message" },
): TelegramUpdate & { kind: "message" } {
  const raw = { ...update.message.raw, [TELEGRAM_SERIES_ADDRESSED_KEY]: true };
  return { ...update, message: { ...update.message, raw } };
}

export function wasAddressedInSeries(raw: Record<string, unknown>): boolean {
  return raw[TELEGRAM_SERIES_ADDRESSED_KEY] === true;
}

export type TelegramSeriesMarker =
  | { role: "context" }
  | {
      addressed: boolean;
      earlierUpdateIds?: string[];
      role: "current";
      telegramMessageIds: string[];
    };

export function isSeriesEligible(update: TelegramUpdate, botUsername: string): boolean {
  if (update.kind !== "message") return false;
  const message = update.message;
  if (message.chat.type === "channel") return false;
  // A channel post has no personal sender; voice and media other than photos and readable files
  // keep their own turn. Photos, files and forwards join (an album is one turn, 25 November 2026).
  if (!message.from || Object.hasOwn(message.raw, "sender_chat")) return false;
  if (Object.hasOwn(message.raw, "voice")) return false;
  const media = classifyTelegramInboundMedia(message);
  if (media === "unsupported_media") return false;
  const text = telegramMessageText(message).trim();
  if (media === "none" && !text) return false;
  if (isTelegramSlashCommand(text)) return false;
  // Replies and mentions that point at someone other than this bot are that person's thread; a
  // forward's mentions are its author's words, not the sender's.
  if (message.replyToMessage && !isReplyToBot(message, botUsername)) return false;
  if (!isTelegramForward(message.raw) && mentionsAnotherUsername(text, botUsername)) {
    return false;
  }
  return true;
}

export function continuesSeries(
  head: TelegramUpdate,
  candidate: TelegramUpdate,
  botUsername: string,
): boolean {
  if (!isSeriesEligible(head, botUsername) || !isSeriesEligible(candidate, botUsername)) {
    return false;
  }
  const first = (head as { message: TelegramMessage }).message;
  const next = (candidate as { message: TelegramMessage }).message;
  return (
    first.chat.id === next.chat.id &&
    (first.messageThreadId ?? null) === (next.messageThreadId ?? null) &&
    first.from?.id === next.from?.id &&
    first.from?.isBot === next.from?.isBot
  );
}

export function withSeriesMarker(
  update: TelegramUpdate & { kind: "message" },
  marker: TelegramSeriesMarker,
): TelegramUpdate {
  const raw = { ...update.message.raw, [TELEGRAM_SERIES_MARKER_KEY]: marker };
  return { ...update, message: { ...update.message, raw } };
}

export function readTelegramSeriesMarker(
  raw: Record<string, unknown>,
): TelegramSeriesMarker | null {
  const value = raw[TELEGRAM_SERIES_MARKER_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const marker = value as Record<string, unknown>;
  if (marker.role === "context") return { role: "context" };
  if (
    marker.role === "current" &&
    typeof marker.addressed === "boolean" &&
    Array.isArray(marker.telegramMessageIds) &&
    marker.telegramMessageIds.every((id) => typeof id === "string" && /^[1-9]\d*$/u.test(id))
  ) {
    const earlier =
      Array.isArray(marker.earlierUpdateIds) &&
      marker.earlierUpdateIds.every((id) => typeof id === "string" && /^[1-9]\d*$/u.test(id))
        ? { earlierUpdateIds: marker.earlierUpdateIds as string[] }
        : {};
    return {
      addressed: marker.addressed,
      ...earlier,
      role: "current",
      telegramMessageIds: marker.telegramMessageIds as string[],
    };
  }
  return null;
}
