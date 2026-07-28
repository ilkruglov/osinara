/**
 * Shared Telegram group message persistence primitives.
 *
 * Exports:
 * - Message field normalizers for trusted PostgreSQL writes.
 * - `lockTelegramGroupJournal` and `pruneTelegramGroupJournal` transaction helpers.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import type { PoolClient } from "pg";

import { TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES } from "../config.js";

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const MILLISECONDS_PER_SECOND = 1_000;

export function requireTelegramPositiveBigint(value: string, field: string): string {
  if (!/^[1-9]\d*$/u.test(value) || BigInt(value) > POSTGRES_BIGINT_MAX) {
    throw new Error(
      `AGENT_TELEGRAM_MESSAGE_INVALID: Telegram передал некорректное поле ${field}`,
    );
  }
  return value;
}

export function telegramMessageThreadId(value: number | undefined): string | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      "AGENT_TELEGRAM_MESSAGE_INVALID: Telegram передал некорректный идентификатор темы",
    );
  }
  return String(value);
}

export function telegramMessageSentAt(message: TelegramMessage): Date {
  const unixSeconds = message.raw.date;
  if (!Number.isSafeInteger(unixSeconds) || Number(unixSeconds) < 0) {
    throw new Error(
      "AGENT_TELEGRAM_MESSAGE_INVALID: Telegram не передал корректное время сообщения",
    );
  }
  const date = new Date(Number(unixSeconds) * MILLISECONDS_PER_SECOND);
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      "AGENT_TELEGRAM_MESSAGE_INVALID: Telegram не передал корректное время сообщения",
    );
  }
  return date;
}

export function telegramMessageKind(message: TelegramMessage): string {
  // Media keys survive Eve parsing in `raw`; only the compact kind is persisted.
  for (const kind of [
    "voice",
    "audio",
    "video",
    "video_note",
    "sticker",
    "animation",
    "contact",
    "location",
    "venue",
    "poll",
    "dice",
    "game",
  ]) {
    if (message.raw[kind] !== undefined) return kind;
  }
  if (message.attachments.some((attachment) => attachment.kind === "photo")) return "photo";
  if (message.attachments.some((attachment) => attachment.kind === "document")) return "document";
  if (message.text || message.caption) return "text";
  return "other";
}

export function telegramMessageContent(message: TelegramMessage): string | null {
  const content = [message.text, message.caption].filter(Boolean).join("\n").trim();
  return content || null;
}

export function telegramSenderDisplayName(message: TelegramMessage): string | null {
  const sender = message.from;
  if (!sender) return null;
  const name = [sender.firstName, sender.lastName].filter(Boolean).join(" ").trim();
  return name || null;
}

export async function lockTelegramGroupJournal(
  client: PoolClient,
  groupId: string,
): Promise<void> {
  // One transaction per group owns insertion and pruning, preventing concurrent cap overruns.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [groupId]);
}

export async function pruneTelegramGroupJournal(
  client: PoolClient,
  groupId: string,
): Promise<void> {
  await client.query(
    `DELETE FROM telegram_group_messages
     WHERE id IN (
       SELECT id FROM telegram_group_messages
       WHERE group_id = $1
       ORDER BY telegram_message_id DESC
       OFFSET $2
     )`,
    [groupId, TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES],
  );
}
