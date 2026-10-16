/**
 * Stable application conversation and verified participant boundary.
 *
 * Exports:
 * - `ApplicationConversation`: Telegram-chat application identity and trust-zone partition.
 * - `ConversationParticipant`: opaque conversation-local Telegram participant identity.
 * - `conversationRepository`: lookup, exact timeline synchronization, and scoped ref resolution.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { CONVERSATION_TIMELINE_SELECTION_MAX_ENTRIES } from "./memory-config.js";
import type { MemoryScope } from "./memory-context.js";

export interface ApplicationConversation {
  familyId: string;
  id: string;
  label: string;
  ownerUserId: string | null;
  scope: MemoryScope;
  scopePartitionKey: string;
  telegramChatId: string;
  telegramGroupId: string | null;
}

export interface ConversationParticipant {
  conversationId: string;
  displayNameSnapshot: string | null;
  firstObservedAt: string;
  id: string;
  lastObservedAt: string;
  linkedUserId: string | null;
  participantRef: string;
  telegramUserId: string;
  usernameSnapshot: string | null;
}

interface ConversationRow {
  family_id: string;
  id: string;
  label: string;
  owner_user_id: string | null;
  scope: MemoryScope;
  scope_partition_key: string;
  telegram_chat_id: string;
  telegram_group_id: string | null;
}

interface ParticipantRow {
  conversation_id: string;
  display_name_snapshot: string | null;
  username_snapshot: string | null;
  first_observed_at: Date;
  id: string;
  last_observed_at: Date;
  linked_user_id: string | null;
  participant_ref: string;
  telegram_user_id: string;
}

function projectConversation(row: ConversationRow): ApplicationConversation {
  return {
    familyId: row.family_id,
    id: row.id,
    label: row.label,
    ownerUserId: row.owner_user_id,
    scope: row.scope,
    scopePartitionKey: row.scope_partition_key,
    telegramChatId: row.telegram_chat_id,
    telegramGroupId: row.telegram_group_id,
  };
}

function projectParticipant(row: ParticipantRow): ConversationParticipant {
  return {
    conversationId: row.conversation_id,
    displayNameSnapshot: row.display_name_snapshot,
    firstObservedAt: row.first_observed_at.toISOString(),
    id: row.id,
    lastObservedAt: row.last_observed_at.toISOString(),
    linkedUserId: row.linked_user_id,
    participantRef: row.participant_ref,
    telegramUserId: row.telegram_user_id,
    usernameSnapshot: row.username_snapshot,
  };
}

function requireEntryIds(entryIds: readonly string[]): string[] {
  const unique = [...new Set(entryIds)];
  if (
    unique.length === 0 ||
    unique.length !== entryIds.length ||
    unique.length > CONVERSATION_TIMELINE_SELECTION_MAX_ENTRIES
  ) {
    throw new AppError(
      "AGENT_CONVERSATION_TIMELINE_SELECTION_INVALID",
      "Набор записей разговора пуст, содержит повторы или превышает допустимый размер",
    );
  }
  return unique;
}

export const conversationRepository = {
  async getByChatId(telegramChatId: string): Promise<ApplicationConversation> {
    const result = await database().query<ConversationRow>(
      `SELECT id, family_id, owner_user_id, telegram_group_id, telegram_chat_id, scope,
              scope_partition_key, label
       FROM application_conversations
       WHERE telegram_chat_id = $1`,
      [telegramChatId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new AppError(
        "AGENT_APPLICATION_CONVERSATION_NOT_FOUND",
        "Для этого Telegram-чата не найден стабильный разговор",
      );
    }
    return projectConversation(row);
  },

  async getById(conversationId: string): Promise<ApplicationConversation> {
    const result = await database().query<ConversationRow>(
      `SELECT id, family_id, owner_user_id, telegram_group_id, telegram_chat_id, scope,
              scope_partition_key, label
       FROM application_conversations WHERE id = $1`,
      [conversationId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new AppError(
        "AGENT_APPLICATION_CONVERSATION_NOT_FOUND",
        "Стабильный разговор больше не существует",
      );
    }
    return projectConversation(row);
  },

  async getByGroupId(groupId: string): Promise<ApplicationConversation> {
    const result = await database().query<ConversationRow>(
      `SELECT id, family_id, owner_user_id, telegram_group_id, telegram_chat_id, scope,
              scope_partition_key, label
       FROM application_conversations
       WHERE telegram_group_id = $1`,
      [groupId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new AppError(
        "AGENT_APPLICATION_CONVERSATION_NOT_FOUND",
        "Для этой Telegram-группы не найден стабильный разговор",
      );
    }
    return projectConversation(row);
  },

  /**
   * The participant of this conversation the chat shows under a username or a display name: an
   * exact match first (case-insensitive), else the one participant whose name starts with the
   * handle; two candidates mean the handle is not a name but a guess.
   */
  async findParticipantByHandle(
    conversationId: string,
    handle: { displayName?: string; telegramUserId?: string; username?: string },
  ): Promise<ConversationParticipant | null> {
    const username = handle.username?.replace(/^@/u, "").trim() || null;
    const displayName = handle.displayName?.trim() || null;
    const telegramUserId = handle.telegramUserId?.trim() || null;
    if (username === null && displayName === null && telegramUserId === null) return null;
    // A Telegram id is resolved here too: a person who never wrote in this conversation is not
    // reachable through it, whatever the id (security review, 16 октября 2026).
    const exact = await database().query<ParticipantRow>(
      `SELECT id, participant_ref, conversation_id, telegram_user_id, linked_user_id,
              display_name_snapshot, username_snapshot, first_observed_at, last_observed_at
       FROM conversation_participants
       WHERE conversation_id = $1
         AND (($2::text IS NOT NULL AND lower(username_snapshot) = lower($2))
           OR ($3::text IS NOT NULL AND lower(display_name_snapshot) = lower($3))
           OR ($4::text IS NOT NULL AND telegram_user_id = $4))
       ORDER BY last_observed_at DESC LIMIT 2`,
      [conversationId, username, displayName, telegramUserId],
    );
    // Two exact matches are namesakes: the handle names nobody in particular.
    if (exact.rows.length === 1) return projectParticipant(exact.rows[0]!);
    if (exact.rows.length > 1 || displayName === null) return null;
    const prefix = await database().query<ParticipantRow>(
      `SELECT id, participant_ref, conversation_id, telegram_user_id, linked_user_id,
              display_name_snapshot, username_snapshot, first_observed_at, last_observed_at
       FROM conversation_participants
       WHERE conversation_id = $1 AND lower(display_name_snapshot) LIKE lower($2) || '%' ESCAPE '\\'
       ORDER BY last_observed_at DESC LIMIT 2`,
      [conversationId, displayName.replace(/[%_\\]/gu, "\\$&")],
    );
    return prefix.rows.length === 1 ? projectParticipant(prefix.rows[0]!) : null;
  },

  async resolveParticipantRef(
    conversationId: string,
    participantRef: string,
  ): Promise<ConversationParticipant> {
    const result = await database().query<ParticipantRow>(
      `SELECT id, participant_ref, conversation_id, telegram_user_id, linked_user_id,
              display_name_snapshot, username_snapshot, first_observed_at, last_observed_at
       FROM conversation_participants
       WHERE conversation_id = $1 AND participant_ref = $2`,
      [conversationId, participantRef],
    );
    const row = result.rows[0];
    if (!row) {
      throw new AppError(
        "AGENT_CONVERSATION_PARTICIPANT_NOT_FOUND",
        "Участник не найден в текущем разговоре",
      );
    }
    return projectParticipant(row);
  },

  async syncTimelineParticipants(
    conversationId: string,
    timelineEntryIds: readonly string[],
  ): Promise<ConversationParticipant[]> {
    const entryIds = requireEntryIds(timelineEntryIds);
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const conversation = await client.query<ConversationRow>(
        `SELECT id, family_id, owner_user_id, telegram_group_id, telegram_chat_id, scope,
                scope_partition_key, label
         FROM application_conversations WHERE id = $1 FOR SHARE`,
        [conversationId],
      );
      const boundary = conversation.rows[0];
      if (!boundary) {
        throw new AppError(
          "AGENT_APPLICATION_CONVERSATION_NOT_FOUND",
          "Стабильный разговор больше не существует",
        );
      }

       // Every requested entry must belong to this conversation. Agent entries are valid selections
      // but never become human participants.
      const selected = await client.query<{
        actor_kind: "agent_self" | "telegram_bot" | "telegram_channel" | "user";
        sender_display_name: string | null;
        sender_username: string | null;
        sent_at: Date;
        telegram_user_id: string | null;
      }>(
        `SELECT actor_kind, telegram_user_id, sender_display_name, sender_username, sent_at
         FROM telegram_group_messages
         WHERE conversation_id = $1 AND id = ANY($2::uuid[])
         ORDER BY sequence_id`,
        [boundary.id, entryIds],
      );
      if (selected.rows.length !== entryIds.length) {
        throw new AppError(
          "AGENT_CONVERSATION_TIMELINE_BOUNDARY_INVALID",
          "Одна или несколько записей не принадлежат выбранному разговору",
        );
      }
      // A bot has a Telegram user id of its own; it becomes a participant without an account link.
      const users = selected.rows.filter((row) =>
        row.actor_kind === "user" || row.actor_kind === "telegram_bot"
      );
      if (users.some((row) => row.telegram_user_id === null)) {
        throw new AppError(
          "AGENT_CONVERSATION_PARTICIPANT_IDENTITY_MISSING",
          "В пользовательской записи отсутствует проверенный Telegram user ID",
        );
      }

      // Upsert uses only Telegram user ID. The latest observed display name is a mutable snapshot,
      // and exact users.telegram_user_id equality is the only application-user link.
      for (const row of users) {
        await client.query(
          `INSERT INTO conversation_participants
             (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
              linked_user_id, display_name_snapshot, username_snapshot, first_observed_at, last_observed_at)
           VALUES ($1, $2, $3, $4, $5,
                   (SELECT id FROM users WHERE telegram_user_id = $5), $6, $8, $7, $7)
           ON CONFLICT (conversation_id, telegram_user_id) DO UPDATE
           SET linked_user_id = (SELECT id FROM users WHERE telegram_user_id = EXCLUDED.telegram_user_id),
               display_name_snapshot = CASE
                 WHEN EXCLUDED.last_observed_at >= conversation_participants.last_observed_at
                 THEN EXCLUDED.display_name_snapshot
                 ELSE conversation_participants.display_name_snapshot
               END,
               username_snapshot = CASE
                 WHEN EXCLUDED.last_observed_at >= conversation_participants.last_observed_at
                 THEN EXCLUDED.username_snapshot
                 ELSE conversation_participants.username_snapshot
               END,
               first_observed_at = least(conversation_participants.first_observed_at, EXCLUDED.first_observed_at),
               last_observed_at = greatest(conversation_participants.last_observed_at, EXCLUDED.last_observed_at),
               updated_at = now()`,
          [boundary.id, boundary.family_id, boundary.scope, boundary.scope_partition_key,
            row.telegram_user_id, row.sender_display_name, row.sent_at,
            // The column check bounds it; an over-long value is shown as no username at all.
            row.sender_username && row.sender_username.length <= 64 ? row.sender_username : null],
        );
      }

      const telegramUserIds = users.map((row) => row.telegram_user_id!);
      const result = telegramUserIds.length === 0
        ? { rows: [] as ParticipantRow[] }
        : await client.query<ParticipantRow>(
            `SELECT id, participant_ref, conversation_id, telegram_user_id, linked_user_id,
                    display_name_snapshot, username_snapshot, first_observed_at, last_observed_at
             FROM conversation_participants
             WHERE conversation_id = $1 AND telegram_user_id = ANY($2::text[])
             ORDER BY telegram_user_id`,
            [conversationId, telegramUserIds],
          );
      await client.query("COMMIT");
      return result.rows.map(projectParticipant);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
