/**
 * Verified nested Telegram reply-target projection.
 *
 * Exports:
 * - `TelegramReplyTargetSnapshot`: model-safe text and attribution for an unavailable reply target.
 * - `TelegramReplyTargetProjection`: everything one inbound message may say about its reply target.
 * - `TELEGRAM_REPLY_QUOTE_MAX_CHARACTERS`: bound of the selected fragment shown to the model.
 * - `telegramReplyTargetProjection`: verifies the target once, then projects its untrusted content.
 */
import type { TelegramMessage } from "eve/channels/telegram";

import { clipText } from "./display-text.js";
import { asRecord as record, nonEmptyText } from "./json-value.js";

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
    ? nonEmptyText(sender.title) ?? senderUsername
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
  console.error(JSON.stringify({
    code: REJECTED_TARGET_CODE,
    reason,
    telegramChatId: message.chat.id,
    telegramReplyTargetChatId: message.replyToMessage?.chat.id ?? null,
    telegramReplyTargetMessageId: message.replyToMessage?.messageId ?? null,
  }));
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

function targetSnapshot(rawTarget: JsonRecord): TelegramReplyTargetSnapshot | null {
  const contentText = [nonEmptyText(rawTarget.text), nonEmptyText(rawTarget.caption)]
    .filter((part): part is string => part !== null)
    .join("\n");
  if (!contentText) return null;

  return { contentText, ...senderProjection(rawTarget) };
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

  const quotedText = nonEmptyText(record(message.raw.quote)?.text);
  return {
    quotedText: quotedText === null ? null : clipText(quotedText, TELEGRAM_REPLY_QUOTE_MAX_CHARACTERS),
    snapshot: targetSnapshot(rawTarget),
  };
}
