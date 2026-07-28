/**
 * PostgreSQL Telegram group journal repository.
 *
 * Exports:
 * - `TelegramGroupJournalRepository`: injectable record/context lookup contract.
 * - `telegramGroupJournalRepository`: normalized, deduplicated, retention-bounded journal.
 */
import type { TelegramMessage } from "eve/channels/telegram";

import {
  TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES,
} from "../config.js";
import { database } from "./database.js";
import type {
  TelegramGroupAttachmentSummary,
  TelegramGroupJournalEntry,
} from "./telegram-group-journal-context.js";
import {
  lockTelegramGroupJournal,
  pruneTelegramGroupJournal,
  requireTelegramPositiveBigint,
  telegramMessageContent,
  telegramMessageKind,
  telegramMessageSentAt,
  telegramMessageThreadId,
  telegramSenderDisplayName,
} from "./telegram-group-message-storage.js";

interface ListJournalInput {
  beforeTelegramMessageId: string;
  groupId: string;
  limit: number;
  messageThreadId: string | null;
}

export interface TelegramGroupJournalRepository {
  listBefore(input: ListJournalInput): Promise<TelegramGroupJournalEntry[]>;
  record(
    groupId: string,
    message: TelegramMessage,
  ): Promise<"duplicate" | "inserted" | "mode_disabled">;
}

interface JournalRow {
  attachment_file_id: string | null;
  attachment_file_name: string | null;
  attachment_file_unique_id: string | null;
  attachment_kind: "document" | "photo" | null;
  attachment_media_type: string | null;
  attachment_size: string | null;
  content_text: string | null;
  message_kind: string;
  message_thread_id: string | null;
  reply_to_message_id: string | null;
  sender_display_name: string | null;
  sender_is_bot: boolean;
  sender_username: string | null;
  sent_at: Date;
  telegram_message_id: string;
  telegram_user_id: string | null;
  id: string;
}

function attachmentSummary(
  row: Pick<JournalRow, "attachment_file_name" | "attachment_media_type" | "attachment_size" | "id">,
  kind: "document" | "photo",
): TelegramGroupAttachmentSummary {
  return {
    attachmentId: row.id,
    ...(row.attachment_file_name === null ? {} : { fileName: row.attachment_file_name }),
    kind,
    ...(row.attachment_media_type === null ? {} : { mediaType: row.attachment_media_type }),
    ...(row.attachment_size === null ? {} : { size: Number(row.attachment_size) }),
  };
}

export const telegramGroupJournalRepository: TelegramGroupJournalRepository = {
  async record(groupId, message) {
    const messageId = requireTelegramPositiveBigint(message.messageId, "message_id");
    const threadId = telegramMessageThreadId(message.messageThreadId);
    const replyToMessageId = message.replyToMessage
      ? requireTelegramPositiveBigint(message.replyToMessage.messageId, "reply_to_message_id")
      : null;
    const sender = message.from;
    if (!sender) {
      throw new Error(
        "AGENT_TELEGRAM_MESSAGE_INVALID: Telegram не передал отправителя группового сообщения",
      );
    }
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await lockTelegramGroupJournal(client, groupId);

      // ON CONFLICT is the webhook idempotency boundary and never mutates the first delivery.
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO telegram_group_messages
           (group_id, telegram_message_id, message_thread_id, telegram_user_id,
            sender_username, sender_display_name, sender_is_bot, message_kind,
            content_text, reply_to_message_id, sent_at)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
         FROM telegram_groups
         WHERE id = $1 AND message_mode = 'all'
         ON CONFLICT (group_id, telegram_message_id) DO NOTHING
         RETURNING id`,
        [
          groupId,
          messageId,
          threadId,
          sender.id,
          sender.username ?? null,
          telegramSenderDisplayName(message),
          sender.isBot,
          telegramMessageKind(message),
          telegramMessageContent(message),
          replyToMessageId,
          telegramMessageSentAt(message),
        ],
      );
      if (!inserted.rowCount) {
        const currentMode = await client.query<{ message_mode: "addressed_only" | "all" }>(
          "SELECT message_mode FROM telegram_groups WHERE id = $1",
          [groupId],
        );
        await client.query("COMMIT");
        return currentMode.rows[0]?.message_mode === "all" ? "duplicate" : "mode_disabled";
      }

      // Retention is physical and group-wide; topic isolation applies only to model reads.
      await pruneTelegramGroupJournal(client, groupId);
      await client.query("COMMIT");
      return "inserted";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async listBefore(input) {
    requireTelegramPositiveBigint(input.beforeTelegramMessageId, "message_id");
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit <= 0 ||
      input.limit > TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES
    ) {
      throw new Error(
        `AGENT_TELEGRAM_JOURNAL_LIMIT_INVALID: Лимит сообщений журнала должен быть целым числом от 1 до ${TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES}`,
      );
    }
    if (input.messageThreadId !== null) {
      requireTelegramPositiveBigint(input.messageThreadId, "message_thread_id");
    }

    // The inner query takes the newest numeric IDs; the outer query restores chronology.
    const result = await database().query<JournalRow>(
      `SELECT * FROM (
         SELECT id, telegram_message_id::text, message_thread_id::text,
                 telegram_user_id, sender_username, sender_display_name, sender_is_bot,
                 message_kind, content_text, reply_to_message_id::text, sent_at,
                 attachment_file_id, attachment_file_unique_id, attachment_file_name,
                 attachment_media_type, attachment_size::text, attachment_kind
         FROM telegram_group_messages
         WHERE group_id = $1
           AND telegram_message_id < $2
           AND message_thread_id IS NOT DISTINCT FROM $3::bigint
         ORDER BY telegram_message_id DESC
         LIMIT $4
       ) AS recent
       ORDER BY telegram_message_id::bigint ASC`,
      [
        input.groupId,
        input.beforeTelegramMessageId,
        input.messageThreadId,
        input.limit,
      ],
    );
    return result.rows.map((row) => ({
      ...(row.attachment_file_id === null || row.attachment_kind === null
        ? {}
        : { attachment: attachmentSummary(row, row.attachment_kind) }),
      contentText: row.content_text,
      messageKind: row.message_kind,
      messageThreadId: row.message_thread_id,
      replyToMessageId: row.reply_to_message_id,
      senderDisplayName: row.sender_display_name,
      senderIsBot: row.sender_is_bot,
      senderUsername: row.sender_username,
      sentAt: row.sent_at.toISOString(),
      telegramMessageId: row.telegram_message_id,
      telegramUserId: row.telegram_user_id,
    }));
  },
};
