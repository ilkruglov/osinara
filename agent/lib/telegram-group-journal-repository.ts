/**
 * PostgreSQL unified Telegram group timeline repository.
 *
 * Exports:
 * - `TelegramGroupJournalRepository`: inbound, agent-delivery, context, and search contract.
 * - `TelegramGroupHistorySearchInput`: bounded model-history query after trusted authorization.
 * - `telegramGroupJournalRepository`: monotonic timeline with chunk aliases and retention.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import type { PoolClient } from "pg";

import { TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES } from "../config.js";
import { database } from "./database.js";
import type {
  TelegramGroupAttachmentSummary,
  TelegramGroupJournalEntry,
} from "./telegram-group-journal-context.js";
import {
  lockTelegramGroupJournal,
  pruneTelegramGroupJournal,
  requireTelegramPositiveBigint,
  telegramForumTopicId,
  telegramMessageContent,
  telegramMessageKind,
  telegramMessageSentAt,
  telegramSenderDisplayName,
} from "./telegram-group-message-storage.js";

const AGENT_ACTOR_ID = "agent:osinara";
const AGENT_DISPLAY_NAME = "Осинара";
const HISTORY_MAX_LIMIT = 100;

interface ListRecentInput {
  anchorEntryId: string | null;
  beforeSequence: string | null;
  groupId: string;
  limit: number;
  messageThreadId: string | null;
}

export interface TelegramGroupHistorySearchInput extends ListRecentInput {
  allTopics?: boolean;
  from?: Date | null;
  participant?: string | null;
  query?: string | null;
  sequenceFrom?: string | null;
  sequenceTo?: string | null;
  to?: Date | null;
}

export interface TimelineRecordResult {
  entryId: string;
  replyToAgent: boolean;
  sequenceId: string;
  status: "duplicate" | "inserted";
}

interface RecordAgentResponseInput {
  contentText: string;
  deliveredAt: Date;
  groupId: string;
  messageThreadId: string | null;
  replyToEntryId: string | null;
  telegramMessageIds: readonly string[];
}

export interface TelegramGroupJournalRepository {
  listRecent(input: ListRecentInput): Promise<TelegramGroupJournalEntry[]>;
  record(groupId: string, message: TelegramMessage): Promise<TimelineRecordResult>;
  recordAgentResponse(input: RecordAgentResponseInput): Promise<{ entryId: string; sequenceId: string }>;
  search(input: TelegramGroupHistorySearchInput): Promise<{
    entries: TelegramGroupJournalEntry[];
    nextBeforeSequence: string | null;
  }>;
}

interface TimelineRow {
  actor_id: string;
  actor_kind: "agent_self" | "user";
  attachment_file_name: string | null;
  attachment_kind: "document" | "photo" | null;
  attachment_media_type: string | null;
  attachment_size: string | null;
  content_text: string | null;
  id: string;
  message_kind: string;
  message_thread_id: string | null;
  reply_to_message_id: string | null;
  reply_to_sequence_id: string | null;
  sender_display_name: string | null;
  sender_is_bot: boolean;
  sender_username: string | null;
  sent_at: Date;
  sequence_id: string;
  telegram_message_id: string;
  telegram_user_id: string | null;
}

const TIMELINE_COLUMNS = `message.id, message.sequence_id::text, message.actor_kind,
  message.actor_id, message.telegram_message_id::text, message.message_thread_id::text,
  message.telegram_user_id, message.sender_username, message.sender_display_name,
  message.sender_is_bot, message.message_kind, message.content_text,
  message.reply_to_message_id::text, message.reply_to_sequence_id::text,
  message.sent_at, message.attachment_file_name, message.attachment_media_type,
  message.attachment_size::text, message.attachment_kind`;

function attachment(row: TimelineRow): TelegramGroupAttachmentSummary | undefined {
  if (row.attachment_kind === null) return undefined;
  return {
    attachmentId: row.id,
    ...(row.attachment_file_name === null ? {} : { fileName: row.attachment_file_name }),
    kind: row.attachment_kind,
    ...(row.attachment_media_type === null ? {} : { mediaType: row.attachment_media_type }),
    ...(row.attachment_size === null ? {} : { size: Number(row.attachment_size) }),
  };
}

function project(row: TimelineRow): TelegramGroupJournalEntry {
  const summary = attachment(row);
  return {
    ...(summary === undefined ? {} : { attachment: summary }),
    actorId: row.actor_id,
    actorKind: row.actor_kind,
    contentText: row.content_text,
    messageKind: row.message_kind,
    messageThreadId: row.message_thread_id,
    replyToMessageId: row.reply_to_message_id,
    replyToSequenceId: row.reply_to_sequence_id,
    senderDisplayName: row.sender_display_name,
    senderIsBot: row.sender_is_bot,
    senderUsername: row.sender_username,
    sentAt: row.sent_at.toISOString(),
    sequenceId: row.sequence_id,
    telegramMessageId: row.telegram_message_id,
    telegramUserId: row.telegram_user_id,
  };
}

function validateList(input: ListRecentInput, maxLimit: number): void {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > maxLimit) {
    throw new Error(
      `AGENT_TELEGRAM_TIMELINE_LIMIT_INVALID: Лимит истории должен быть целым числом от 1 до ${maxLimit}`,
    );
  }
  if (input.beforeSequence !== null) requireTelegramPositiveBigint(input.beforeSequence, "before_sequence");
  if (input.messageThreadId !== null) requireTelegramPositiveBigint(input.messageThreadId, "message_thread_id");
}

async function nextSequence(client: PoolClient, groupId: string): Promise<string> {
  const result = await client.query<{ sequence_id: string }>(
    `UPDATE telegram_groups
     SET next_timeline_sequence = greatest(
       next_timeline_sequence,
       coalesce((SELECT max(sequence_id) FROM telegram_group_messages WHERE group_id = $1), 0)
     ) + 1
     WHERE id = $1 RETURNING next_timeline_sequence::text AS sequence_id`,
    [groupId],
  );
  const sequence = result.rows[0]?.sequence_id;
  if (!sequence) throw new Error("AGENT_TELEGRAM_GROUP_NOT_FOUND: Группа не зарегистрирована");
  return sequence;
}

async function listRows(input: ListRecentInput): Promise<TelegramGroupJournalEntry[]> {
  validateList(input, TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES);
  // Recursive ancestors are bounded to two trusted reply edges and may cross the recent window.
  const result = await database().query<TimelineRow>(
    `WITH RECURSIVE recent AS (
       SELECT id FROM telegram_group_messages
       WHERE group_id = $1
         AND message_thread_id IS NOT DISTINCT FROM $2::bigint
         AND ($3::bigint IS NULL OR sequence_id < $3)
       ORDER BY sequence_id DESC LIMIT $4
     ), ancestry(id, depth) AS (
       SELECT id, 0 FROM recent
       UNION
       SELECT id, 0 FROM telegram_group_messages
       WHERE id = $5::uuid AND group_id = $1
       UNION
       SELECT parent.id, ancestry.depth + 1
       FROM ancestry
       JOIN telegram_group_messages child ON child.id = ancestry.id
       JOIN telegram_group_messages parent ON parent.id = child.reply_to_entry_id
       WHERE ancestry.depth < 2 AND parent.group_id = $1
     )
     SELECT ${TIMELINE_COLUMNS}
     FROM telegram_group_messages message
     WHERE message.id IN (SELECT id FROM ancestry)
       AND ($5::uuid IS NULL OR message.id <> $5)
     ORDER BY message.sequence_id`,
    [input.groupId, input.messageThreadId, input.beforeSequence, input.limit, input.anchorEntryId],
  );
  return result.rows.map(project);
}

export const telegramGroupJournalRepository: TelegramGroupJournalRepository = {
  async record(groupId, message) {
    const messageId = requireTelegramPositiveBigint(message.messageId, "message_id");
    const sender = message.from;
    if (!sender) {
      throw new Error("AGENT_TELEGRAM_MESSAGE_INVALID: Telegram не передал отправителя группового сообщения");
    }
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await lockTelegramGroupJournal(client, groupId);
      const duplicate = await client.query<{ entry_id: string; sequence_id: string }>(
        `SELECT alias.entry_id, message.sequence_id::text
         FROM telegram_group_message_ids alias
         JOIN telegram_group_messages message ON message.id = alias.entry_id
         WHERE alias.group_id = $1 AND alias.telegram_message_id = $2`,
        [groupId, messageId],
      );
      if (duplicate.rows[0]) {
        await client.query("COMMIT");
        return {
          entryId: duplicate.rows[0].entry_id,
          replyToAgent: false,
          sequenceId: duplicate.rows[0].sequence_id,
          status: "duplicate",
        };
      }
      const sequenceId = await nextSequence(client, groupId);
      const replyId = message.replyToMessage
        ? requireTelegramPositiveBigint(message.replyToMessage.messageId, "reply_to_message_id")
        : null;
      const replyTarget = replyId === null
        ? null
        : (await client.query<{
          actor_kind: "agent_self" | "user";
          entry_id: string;
          sequence_id: string;
        }>(
          `SELECT alias.entry_id, target.actor_kind, target.sequence_id::text
           FROM telegram_group_message_ids alias
           JOIN telegram_group_messages target ON target.id = alias.entry_id
           WHERE alias.group_id = $1 AND alias.telegram_message_id = $2`,
          [groupId, replyId],
        )).rows[0] ?? null;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO telegram_group_messages
           (group_id, sequence_id, actor_kind, actor_id, telegram_message_id,
            message_thread_id, telegram_user_id, sender_username, sender_display_name,
            sender_is_bot, message_kind, content_text, reply_to_message_id,
            reply_to_entry_id, reply_to_sequence_id, sent_at)
         VALUES ($1, $2, 'user', $3, $4, $5, $6, $7, $8, false, $9, $10, $11, $12, $13, $14)
         RETURNING id`,
        [groupId, sequenceId, `telegram:${sender.id}`, messageId, telegramForumTopicId(message),
          sender.id, sender.username ?? null, telegramSenderDisplayName(message), telegramMessageKind(message),
          telegramMessageContent(message), replyId, replyTarget?.entry_id ?? null,
          replyTarget?.sequence_id ?? null, telegramMessageSentAt(message)],
      );
      const entryId = inserted.rows[0]!.id;
      await client.query(
        "INSERT INTO telegram_group_message_ids (group_id, telegram_message_id, entry_id) VALUES ($1, $2, $3)",
        [groupId, messageId, entryId],
      );
      await pruneTelegramGroupJournal(client, groupId);
      await client.query("COMMIT");
      return {
        entryId,
        replyToAgent: replyTarget?.actor_kind === "agent_self",
        sequenceId,
        status: "inserted",
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async recordAgentResponse(input) {
    if (!input.contentText.trim() || input.telegramMessageIds.length === 0) {
      throw new Error("AGENT_TELEGRAM_TIMELINE_DELIVERY_INVALID: Нет подтверждённого финального ответа для истории");
    }
    const messageIds = input.telegramMessageIds.map((id) => requireTelegramPositiveBigint(id, "message_id"));
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await lockTelegramGroupJournal(client, input.groupId);
      const sequenceId = await nextSequence(client, input.groupId);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO telegram_group_messages
           (group_id, sequence_id, actor_kind, actor_id, telegram_message_id,
            message_thread_id, sender_display_name, sender_is_bot, message_kind,
            content_text, reply_to_entry_id, reply_to_sequence_id, sent_at)
          VALUES ($1, $2, 'agent_self', $3, $4, $5, $6, true, 'text', $7,
                  (SELECT id FROM telegram_group_messages WHERE id = $8 AND group_id = $1),
                  (SELECT sequence_id FROM telegram_group_messages WHERE id = $8 AND group_id = $1),
                  $9)
         RETURNING id`,
        [input.groupId, sequenceId, AGENT_ACTOR_ID, messageIds[0], input.messageThreadId,
          AGENT_DISPLAY_NAME, input.contentText, input.replyToEntryId, input.deliveredAt],
      );
      const entryId = inserted.rows[0]!.id;
      await client.query(
        `INSERT INTO telegram_group_message_ids (group_id, telegram_message_id, entry_id)
         SELECT $1, unnest($2::bigint[]), $3`,
        [input.groupId, messageIds, entryId],
      );
      await pruneTelegramGroupJournal(client, input.groupId);
      await client.query("COMMIT");
      return { entryId, sequenceId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  listRecent: listRows,

  async search(input) {
    validateList(input, HISTORY_MAX_LIMIT);
    for (const value of [input.sequenceFrom, input.sequenceTo]) {
      if (value) requireTelegramPositiveBigint(value, "sequence_range");
    }
    const result = await database().query<TimelineRow>(
      `SELECT ${TIMELINE_COLUMNS}
       FROM telegram_group_messages message
       WHERE message.group_id = $1
          AND ($11::boolean OR message.message_thread_id IS NOT DISTINCT FROM $2::bigint)
         AND ($3::bigint IS NULL OR message.sequence_id < $3)
         AND ($4::bigint IS NULL OR message.sequence_id >= $4)
         AND ($5::bigint IS NULL OR message.sequence_id <= $5)
         AND ($6::timestamptz IS NULL OR message.sent_at >= $6)
         AND ($7::timestamptz IS NULL OR message.sent_at <= $7)
         AND ($8::text IS NULL OR message.actor_id = $8 OR message.sender_username = $8)
         AND ($9::text IS NULL OR position(lower($9) in lower(coalesce(message.content_text, ''))) > 0)
       ORDER BY message.sequence_id DESC LIMIT $10`,
      [input.groupId, input.messageThreadId, input.beforeSequence, input.sequenceFrom,
        input.sequenceTo, input.from, input.to, input.participant, input.query, input.limit + 1,
        input.allTopics === true],
    );
    const hasMore = result.rows.length > input.limit;
    const page = result.rows.slice(0, input.limit).reverse().map(project);
    return { entries: page, nextBeforeSequence: hasMore ? page[0]!.sequenceId : null };
  },
};
