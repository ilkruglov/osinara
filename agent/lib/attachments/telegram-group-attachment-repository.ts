/**
 * Lazy family Telegram attachment reference repository.
 *
 * Exports:
 * - `TelegramGroupAttachmentRepository`: authorized record, list, and materialization lookup contract.
 * - `telegramGroupAttachmentRepository`: PostgreSQL implementation over the bounded group journal.
 */
import type { TelegramMessage } from "eve/channels/telegram";

import { TELEGRAM_ATTACHMENT_REFERENCE_LIST_LIMIT } from "../../config.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { TelegramGroupAttachmentSummary } from "../telegram-group-journal-context.js";
import {
  lockTelegramGroupJournal,
  requireTelegramPositiveBigint,
} from "../telegram-group-message-storage.js";
import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";

interface AttachmentRow {
  attachment_file_id: string;
  attachment_file_name: string | null;
  attachment_file_unique_id: string | null;
  attachment_kind: "document" | "photo";
  attachment_media_type: string | null;
  attachment_size: string | null;
  id: string;
  telegram_chat_id: string;
  telegram_message_id: string;
}

interface AttachmentListRow extends AttachmentRow {
  content_text: string | null;
  sender_display_name: string | null;
  sent_at: Date;
}

export interface TelegramGroupAttachmentRepository {
  find(
    auth: WorkspaceAuthorization,
    attachmentId: string,
  ): Promise<{
    attachment: TelegramMessage["attachments"][number];
    chatId: string;
    messageId: string;
  }>;
  list(
    auth: WorkspaceAuthorization,
    messageThreadId: string | null,
  ): Promise<Array<TelegramGroupAttachmentSummary & {
    contentText: string | null;
    senderDisplayName: string | null;
    sentAt: string;
    telegramMessageId: string;
  }>>;
  record(
    groupId: string,
    message: TelegramMessage,
  ): Promise<TelegramGroupAttachmentSummary & { telegramMessageId: string }>;
}

function attachmentSummary(row: Pick<
  AttachmentRow,
  "attachment_file_name" | "attachment_kind" | "attachment_media_type" | "attachment_size" | "id"
>): TelegramGroupAttachmentSummary {
  return {
    attachmentId: row.id,
    ...(row.attachment_file_name === null ? {} : { fileName: row.attachment_file_name }),
    kind: row.attachment_kind,
    ...(row.attachment_media_type === null ? {} : { mediaType: row.attachment_media_type }),
    ...(row.attachment_size === null ? {} : { size: Number(row.attachment_size) }),
  };
}

function assertFamilyAttachmentAccess(auth: WorkspaceAuthorization): asserts auth is WorkspaceAuthorization & {
  groupId: string;
  groupType: "family_private";
  telegramChatType: "group" | "supergroup";
} {
  if (
    auth.groupType !== "family_private" ||
    auth.groupId === null ||
    (auth.telegramChatType !== "group" && auth.telegramChatType !== "supergroup")
  ) {
    throw new AppError(
      "AGENT_TELEGRAM_ATTACHMENT_ACCESS_DENIED",
      "Вложения доступны только в исходной семейной группе",
    );
  }
}

export const telegramGroupAttachmentRepository: TelegramGroupAttachmentRepository = {
  async find(auth, attachmentId) {
    assertFamilyAttachmentAccess(auth);
    const result = await database().query<AttachmentRow>(
      `SELECT message.id, message.telegram_message_id::text,
              message.attachment_file_id, message.attachment_file_unique_id,
              message.attachment_file_name, message.attachment_media_type,
              message.attachment_size::text, message.attachment_kind,
              telegram_group.telegram_chat_id
       FROM telegram_group_messages message
       JOIN telegram_groups telegram_group ON telegram_group.id = message.group_id
       WHERE message.id = $1 AND message.group_id = $2
         AND telegram_group.family_id = $3 AND telegram_group.type = 'family_private'
         AND message.attachment_file_id IS NOT NULL`,
      [attachmentId, auth.groupId, auth.familyId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new AppError(
        "AGENT_TELEGRAM_ATTACHMENT_NOT_FOUND",
        "Вложение не найдено в текущей семейной группе",
      );
    }
    return {
      attachment: {
        fileId: row.attachment_file_id,
        ...(row.attachment_file_name === null ? {} : { fileName: row.attachment_file_name }),
        ...(row.attachment_file_unique_id === null
          ? {}
          : { fileUniqueId: row.attachment_file_unique_id }),
        kind: row.attachment_kind,
        ...(row.attachment_media_type === null ? {} : { mediaType: row.attachment_media_type }),
        ...(row.attachment_size === null ? {} : { size: Number(row.attachment_size) }),
      },
      chatId: row.telegram_chat_id,
      messageId: row.telegram_message_id,
    };
  },

  async list(auth, messageThreadId) {
    assertFamilyAttachmentAccess(auth);
    if (messageThreadId !== null) {
      requireTelegramPositiveBigint(messageThreadId, "message_thread_id");
    }
    const result = await database().query<AttachmentListRow>(
      `SELECT message.id, message.telegram_message_id::text,
              message.attachment_file_id, message.attachment_file_unique_id,
              message.attachment_file_name, message.attachment_media_type,
              message.attachment_size::text, message.attachment_kind,
              message.content_text, message.sender_display_name, message.sent_at,
              telegram_group.telegram_chat_id
       FROM telegram_group_messages message
       JOIN telegram_groups telegram_group ON telegram_group.id = message.group_id
       WHERE message.group_id = $1 AND telegram_group.family_id = $2
         AND telegram_group.type = 'family_private'
         AND message.message_thread_id IS NOT DISTINCT FROM $3::bigint
         AND message.attachment_file_id IS NOT NULL
       ORDER BY message.telegram_message_id DESC
       LIMIT $4`,
      [auth.groupId, auth.familyId, messageThreadId, TELEGRAM_ATTACHMENT_REFERENCE_LIST_LIMIT],
    );
    return result.rows.map((row) => ({
      ...attachmentSummary(row),
      contentText: row.content_text,
      senderDisplayName: row.sender_display_name,
      sentAt: row.sent_at.toISOString(),
      telegramMessageId: row.telegram_message_id,
    }));
  },

  async record(groupId, message) {
    if (message.attachments.length !== 1) {
      throw new AppError(
        "AGENT_TELEGRAM_ATTACHMENT_REFERENCE_INVALID",
        "Сообщение Telegram должно содержать ровно одно поддерживаемое вложение",
      );
    }
    const attachment = message.attachments[0]!;
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await lockTelegramGroupJournal(client, groupId);
      // The unified timeline owns entry creation and sequence allocation. This repository enriches
      // that exact human entry, so attachments cannot create a second persistence path.
      const result = await client.query<AttachmentRow>(
        `UPDATE telegram_group_messages AS message
         SET attachment_file_id = $3,
             attachment_file_unique_id = $4,
             attachment_file_name = $5,
             attachment_media_type = $6,
             attachment_size = $7,
             attachment_kind = $8
         FROM telegram_groups telegram_group
         WHERE message.group_id = $1
           AND message.telegram_message_id = $2
           AND telegram_group.id = message.group_id
           AND telegram_group.type = 'family_private'
           AND (message.attachment_file_id IS NULL OR (
             message.attachment_file_id = $3 AND
             message.attachment_file_unique_id IS NOT DISTINCT FROM $4 AND
             message.attachment_file_name IS NOT DISTINCT FROM $5 AND
             message.attachment_media_type IS NOT DISTINCT FROM $6 AND
             message.attachment_size IS NOT DISTINCT FROM $7 AND
             message.attachment_kind = $8
           ))
         RETURNING message.id, message.telegram_message_id::text, message.attachment_file_id,
                    attachment_file_unique_id, attachment_file_name, attachment_media_type,
                    attachment_size::text, attachment_kind, ''::text AS telegram_chat_id`,
        [
          groupId,
          requireTelegramPositiveBigint(message.messageId, "message_id"),
          attachment.fileId,
          attachment.fileUniqueId ?? null,
          attachment.fileName ?? null,
          attachment.mediaType ?? null,
          attachment.size ?? null,
          attachment.kind,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new AppError(
          "AGENT_TELEGRAM_ATTACHMENT_REFERENCE_CONFLICT",
          "Не удалось сохранить ссылку на вложение семейной группы",
        );
      }
      await client.query("COMMIT");
      return { ...attachmentSummary(row), telegramMessageId: row.telegram_message_id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
