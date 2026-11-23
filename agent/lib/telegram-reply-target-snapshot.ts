/**
 * Verified nested Telegram reply-target projection.
 *
 * Exports:
 * - `TelegramReplyTargetSnapshot`: model-safe text and attribution for an unavailable reply target.
 * - `TelegramReplyTargetProjection`: everything one inbound message may say about its reply target.
 * - `TELEGRAM_REPLY_QUOTE_MAX_CHARACTERS`: bound of the selected fragment shown to the model.
 * - `TELEGRAM_REPLY_SNAPSHOT_MAX_CHARACTERS`: bound of the full target text shown to the model.
 * - `telegramReplyTargetProjection`: verifies the target once, then projects its untrusted content
 *   as the journal keeps it: a target that tells a secret in words gives neither snapshot nor quote
 *   (the target is unavailable), a quote that tells one is dropped, and keys are masked in the
 *   target text and in the quote both on its own and where it overlaps a key of the target
 *   («FAL_KEY=abcdefghij…» quoted as «abcdefghij»); a quote not found in a target with a key is
 *   dropped. A quote chosen from a rich message is read from `quote.rich_texts` when its text is
 *   empty.
 */
import type { TelegramMessage } from "eve/channels/telegram";

import { clipText } from "./display-text.js";
import { asRecord as record, nonEmptyText } from "./json-value.js";
import { journalText, strictSecretSpans, type SecretSpan } from "./secret-redaction.js";
import { richMessagePlainText, richQuotableText, richQuoteText } from "./telegram-rich-message.js";

export interface TelegramReplyTargetSnapshot {
  contentText: string;
  senderDisplayName: string | null;
  senderUsername: string | null;
}

export interface TelegramReplyTargetProjection {
  /** Full target text, for a target the application cannot resolve from its own history. */
  snapshot: TelegramReplyTargetSnapshot | null;
  /** The fragment the author selected inside the target (Telegram `quote`), when they selected one. */
  quotedText: string | null;
}

/** Telegram itself caps a reply quote at 1 024 characters; a longer one is cut, never trusted whole. */
export const TELEGRAM_REPLY_QUOTE_MAX_CHARACTERS = 1_024;

/**
 * Telegram's copy of a target is a stand-in, not the target's full record: a share of a 4 096-
 * character message. The turn shortens it further to fit its context (`telegram-reply-fit.ts`).
 */
export const TELEGRAM_REPLY_SNAPSHOT_MAX_CHARACTERS = 1_024;

type JsonRecord = Record<string, unknown>;

type TelegramReplyMessage = Pick<TelegramMessage, "chat" | "raw" | "replyToMessage">;

const REJECTED_TARGET_CODE = "AGENT_TELEGRAM_REPLY_TARGET_REJECTED";

const NO_REPLY_TARGET: TelegramReplyTargetProjection = { quotedText: null, snapshot: null };

function exactIdentifier(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

function senderProjection(target: JsonRecord): {
  senderDisplayName: string | null;
  senderUsername: string | null;
} {
  // Anonymous/channel posts carry the real visible author in sender_chat rather than from.
  const senderChat = record(target.sender_chat);
  const sender = senderChat ?? record(target.from);
  if (!sender) return { senderDisplayName: null, senderUsername: null };
  const senderUsername = nonEmptyText(sender.username);
  const senderDisplayName = senderChat
    ? (nonEmptyText(sender.title) ?? senderUsername)
    : [nonEmptyText(sender.first_name), nonEmptyText(sender.last_name)]
        .filter((part): part is string => part !== null)
        .join(" ") || senderUsername;
  return { senderDisplayName, senderUsername };
}

/**
 * A delivered reply always names a target of the same chat, so a refusal here means the transport
 * or the update changed shape. The turn continues without the target; the reason belongs in logs.
 */
function rejectTarget(
  reason: "foreign_chat" | "identity_mismatch",
  message: TelegramReplyMessage,
): null {
  console.error(
    JSON.stringify({
      code: REJECTED_TARGET_CODE,
      reason,
      telegramChatId: message.chat.id,
      telegramReplyTargetChatId: message.replyToMessage?.chat.id ?? null,
      telegramReplyTargetMessageId: message.replyToMessage?.messageId ?? null,
    }),
  );
  return null;
}

/** Parsed and raw Telegram identities must agree before nested untrusted content is admitted. */
function verifiedRawTarget(message: TelegramReplyMessage): JsonRecord | null {
  const parsedTarget = message.replyToMessage;
  const rawTarget = record(message.raw.reply_to_message);
  if (!parsedTarget || !rawTarget) return null;

  // A reply to another chat's message arrives as `external_reply` and never becomes
  // `replyToMessage`; the boundary is still stated here rather than inherited from the transport.
  if (parsedTarget.chat.id !== message.chat.id) return rejectTarget("foreign_chat", message);

  const rawMessageId = exactIdentifier(rawTarget.message_id);
  const rawChatId = exactIdentifier(record(rawTarget.chat)?.id);
  if (rawMessageId !== parsedTarget.messageId || rawChatId !== parsedTarget.chat.id) {
    return rejectTarget("identity_mismatch", message);
  }
  return rawTarget;
}

/**
 * The target's text: as a reader sees it, or, for matching a quote, in Telegram's own form (a rich
 * target's quotable texts each on its own, joined by one line feed).
 */
function targetText(rawTarget: JsonRecord, form: "reader" | "telegram" = "reader"): string {
  // A rich target (a channel post with blocks) has no `text`; its blocks are what the reader saw.
  return (
    [nonEmptyText(rawTarget.text), nonEmptyText(rawTarget.caption)]
      .filter((part): part is string => part !== null)
      .join("\n") ||
    (form === "telegram" ? richQuotableText(rawTarget) : richMessagePlainText(rawTarget)) ||
    ""
  );
}

/** `shownText` is already masked: a cut through a key would leave a piece no shape recognizes. */
function targetSnapshot(
  rawTarget: JsonRecord,
  shownText: string,
): TelegramReplyTargetSnapshot | null {
  if (!shownText) return null;
  return {
    contentText: clipText(shownText, TELEGRAM_REPLY_SNAPSHOT_MAX_CHARACTERS),
    ...senderProjection(rawTarget),
  };
}

/** Keys of a text ordered and merged, so a sweep meets each one once. */
function mergedSpans(spans: readonly SecretSpan[]): SecretSpan[] {
  const merged: SecretSpan[] = [];
  for (const span of [...spans].sort((left, right) => left.start - right.start)) {
    const last = merged.at(-1);
    if (last !== undefined && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/**
 * The parts of a quote that fall on a key of its target. Every place the quote occurs counts:
 * Telegram's own position is only approximate. Occurrences and keys are both in order, so one sweep
 * finds them: pairing each occurrence with each key took 243 ms on a crafted rich target.
 */
function quoteOverlaps(
  quote: string,
  target: string,
  secrets: readonly SecretSpan[],
): SecretSpan[] {
  const keys = mergedSpans(secrets);
  const overlaps: SecretSpan[] = [];
  let first = 0;
  for (let at = target.indexOf(quote); at !== -1; at = target.indexOf(quote, at + 1)) {
    while (first < keys.length && keys[first]!.end <= at) first += 1;
    for (let key = first; key < keys.length && keys[key]!.start < at + quote.length; key += 1) {
      const start = Math.max(keys[key]!.start, at);
      const end = Math.min(keys[key]!.end, at + quote.length);
      overlaps.push({ end: end - at, start: start - at });
    }
  }
  return overlaps;
}

/**
 * The quote as the journal would show it, matched against the target in Telegram's own form (a rich
 * target's blocks joined by one line feed, as quote positions count). One the target does not
 * contain cannot be checked against the target's keys, so with a key in the target it is dropped:
 * «ij0123456789\nотозван» quoted across a masked key came through open (repeat review, 23 November
 * 2026). Only the text Telegram lets one select is read: every string of the raw message, ids and
 * addresses among them, made a card of an emoji's id and dropped harmless quotes (owner, «Проверять
 * только видимый текст»).
 */
function quoteShown(quote: string, target: string): string | null {
  const secrets = strictSecretSpans(target);
  if (target.includes(quote)) return journalText(quote, quoteOverlaps(quote, target, secrets));
  return secrets.length > 0 ? null : journalText(quote);
}

/**
 * Reads the reply target of one inbound message. Telegram sends `quote` when the author replied to
 * a selected fragment instead of the whole message; both the fragment and the full target text are
 * untrusted, so they are admitted only for a target this chat actually delivered, verified once.
 */
export function telegramReplyTargetProjection(
  message: TelegramReplyMessage,
): TelegramReplyTargetProjection {
  const rawTarget = verifiedRawTarget(message);
  if (!rawTarget) return NO_REPLY_TARGET;

  const contentText = targetText(rawTarget);
  // The journal keeps no text of a message that tells a secret in words; nor does its copy here.
  const shownText = journalText(contentText);
  if (shownText === null) return NO_REPLY_TARGET;
  const rawQuote = record(message.raw.quote);
  // A quote chosen from a rich message may come only as its rich texts.
  const quote = nonEmptyText(rawQuote?.text) ?? richQuoteText(rawQuote?.rich_texts);
  const shownQuote = quote === null ? null : quoteShown(quote, targetText(rawTarget, "telegram"));
  return {
    quotedText:
      shownQuote === null ? null : clipText(shownQuote, TELEGRAM_REPLY_QUOTE_MAX_CHARACTERS),
    snapshot: targetSnapshot(rawTarget, shownText),
  };
}
