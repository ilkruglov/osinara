/**
 * PostgreSQL external-group reminder boundary.
 *
 * Exports:
 * - `GroupReminderCreateInput` and `GroupReminderUpdateInput`: validated mutation inputs.
 * - `groupReminderRepository`: replay-safe create/list/update/delete for a public chat.
 *
 * Key constructs:
 * - The author is a verified Telegram user id, because a participant of an external group has no
 *   account here. Both caps are therefore counted per Telegram author and per chat.
 * - Counting and inserting share one transaction under a per-group advisory lock, so two
 *   participants writing at the same moment cannot both pass the same free slot.
 * - Schedule math, lease policy and replay markers come from the shared mutation module, so a
 *   public-chat reminder behaves exactly like a trusted one everywhere except authorization.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { decodeDateUuidCursor, encodeDateUuidCursor, paginationFilterDigest } from "../keyset-pagination.js";
import type { TelegramChatPresenceLookup } from "../telegram-chat-membership.js";
import { GROUP_REMINDER_TIMEZONE, REMINDER_LIST_MAX_LIMIT } from "./reminder-config.js";
import {
  requireFreeGroupSlot,
  requireGroupReminderDestination,
  requireGroupReminderOfThisChat,
  requireGroupReminderTime,
  requireOwnGroupReminder,
  mutationDenied,
  reminderNotFound,
} from "./group-reminder-policy.js";
import type { GroupReminderAuthorization } from "./group-reminder-context.js";
import {
  applyReminderUpdate,
  recordReminderOperation,
  requireReminderNotLeased,
} from "./reminder-mutation.js";
import {
  type ReminderRecord,
  type ReminderRecurrence,
  type ReminderRow,
  reminderOperationHash,
  rowToReminder,
} from "./reminder-record.js";
import {
  REMINDER_COLUMNS,
  findReminderOperation,
  selectReminder,
} from "./reminder-repository-helpers.js";
import { requireReminderContent, requireReminderRecurrence } from "./reminder-validation.js";

export interface GroupReminderCreateInput {
  content: string;
  firstRunAt: Date;
  operationKey: string;
  recurrence: ReminderRecurrence | null;
}

/** A public-chat reminder additionally reports whether the caller may change it. */
export interface GroupReminderRecord extends ReminderRecord {
  mine: boolean;
}

export interface GroupReminderUpdateInput {
  content?: string;
  enabled?: boolean;
  firstRunAt?: Date;
  operationKey: string;
  recurrence?: ReminderRecurrence | null;
}

/**
 * Resolves who may delete this reminder without holding a lock or a connection. A foreign author is
 * accepted only once Telegram confirms they left the chat; a delivery already in flight is refused
 * before the lookup, so an in-flight reminder costs no provider request.
 */
async function requireDeletableGroupReminderAuthor(
  auth: GroupReminderAuthorization,
  id: string,
  resolveAuthorPresence: TelegramChatPresenceLookup,
): Promise<string> {
  const client = await database().connect();
  let reminder;
  try {
    reminder = await selectReminder(client, auth.familyId, id);
  } finally {
    client.release();
  }
  if (!reminder) throw reminderNotFound();
  requireGroupReminderOfThisChat(auth, reminder);
  const author = reminder.author_telegram_user_id;
  if (author === null) throw reminderNotFound();
  requireReminderNotLeased(reminder, "delete");
  if (author === auth.telegramUserId) return author;

  const presence = await resolveAuthorPresence({
    telegramChatId: auth.telegramChatId,
    telegramUserId: author,
  });
  if (presence === "present") {
    throw mutationDenied(
      "Это напоминание поставил другой участник, и он в чате. Удалить его может только он",
    );
  }
  return author;
}

export const groupReminderRepository = {
  async create(
    auth: GroupReminderAuthorization,
    input: GroupReminderCreateInput,
  ): Promise<ReminderRecord> {
    const content = requireReminderContent(input.content);
    const firstRunAt = requireGroupReminderTime(input.firstRunAt);
    const recurrence = requireReminderRecurrence(input.recurrence);
    const inputHash = reminderOperationHash({
      ...input,
      content,
      firstRunAt: firstRunAt.toISOString(),
    });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const replay = await findReminderOperation(
        client,
        auth.familyId,
        input.operationKey,
        "create",
        inputHash,
      );
      if (replay !== undefined) {
        if (!replay) {
          throw new AppError(
            "AGENT_REMINDER_ALREADY_DELETED",
            "Это напоминание уже было создано и затем удалено",
          );
        }
        const existing = await selectReminder(client, auth.familyId, replay);
        if (!existing) throw reminderNotFound();
        // A replayed marker still has to point at this chat and this author: the family owns more
        // than one chat, and a marker is keyed only by family and operation key.
        requireOwnGroupReminder(auth, existing);
        await client.query("COMMIT");
        return rowToReminder(existing);
      }

      // Destination is accepted only from the live registration of the verified current chat.
      await requireGroupReminderDestination(client, auth);
      await requireFreeGroupSlot(client, auth, null);
      const inserted = await client.query<ReminderRow>(
        `INSERT INTO reminders
           (family_id, author_telegram_user_id, group_id, scope, content, timezone,
            telegram_chat_id, recurrence_unit, recurrence_interval,
            recurrence_anchor_local, due_at, available_at)
         VALUES ($1, $2, $3, 'group', $4, $5, $6, $7, $8,
                 $9::timestamptz AT TIME ZONE $5, $9, $9)
         RETURNING ${REMINDER_COLUMNS}`,
        [
          auth.familyId,
          auth.telegramUserId,
          auth.groupId,
          content,
          GROUP_REMINDER_TIMEZONE,
          auth.telegramChatId,
          recurrence?.unit ?? null,
          recurrence?.interval ?? null,
          firstRunAt,
        ],
      );
      const reminder = inserted.rows[0]!;
      await recordReminderOperation(client, {
        familyId: auth.familyId,
        inputHash,
        operationKey: input.operationKey,
        operationKind: "create",
        reminderId: reminder.id,
      });
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, NULL, 'reminder.created', $2,
                 jsonb_build_object('scope', 'group', 'groupId', $3::text,
                                    'telegramUserId', $4::text, 'recurrence', $5::text))`,
        [auth.familyId, reminder.id, auth.groupId, auth.telegramUserId, recurrence?.unit ?? "once"],
      );
      await client.query("COMMIT");
      return rowToReminder(reminder);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * A reminder of a public chat fires in front of everyone, so every participant sees the upcoming
   * ones. A paused reminder is not upcoming and stays visible only to the author who can resume it.
   */
  async list(
    auth: GroupReminderAuthorization,
    options: { cursor?: string; limit: number },
  ): Promise<{ items: GroupReminderRecord[]; nextCursor: string | null }> {
    if (
      !Number.isInteger(options.limit) || options.limit < 1 ||
      options.limit > REMINDER_LIST_MAX_LIMIT
    ) {
      throw new AppError("AGENT_REMINDER_LIMIT_INVALID", "Некорректный размер страницы напоминаний");
    }
    const binding = paginationFilterDigest([auth.groupId, auth.telegramUserId]);
    const cursor = decodeDateUuidCursor(
      options.cursor,
      "AGENT_REMINDER_CURSOR_INVALID",
      "Не удалось продолжить просмотр напоминаний",
      binding,
    );
    const result = await database().query<ReminderRow & { mine: boolean }>(
      `SELECT ${REMINDER_COLUMNS},
              (reminder.author_telegram_user_id = $2) AS mine
       FROM reminders AS reminder
       WHERE reminder.scope = 'group' AND reminder.group_id = $1
         AND (
           reminder.status IN ('active', 'leased') OR
           (reminder.status = 'paused' AND reminder.author_telegram_user_id = $2)
         )
         AND ($3::timestamptz IS NULL OR (reminder.due_at, reminder.id) > ($3, $4::uuid))
       ORDER BY reminder.due_at, reminder.id
       LIMIT $5`,
      [
        auth.groupId,
        auth.telegramUserId,
        cursor?.timestamp ?? null,
        cursor?.id ?? null,
        options.limit + 1,
      ],
    );
    const hasNext = result.rows.length > options.limit;
    const rows = result.rows.slice(0, options.limit);
    const last = rows.at(-1);
    return {
      items: rows.map((row) => ({ ...rowToReminder(row), mine: row.mine })),
      nextCursor: hasNext && last ? encodeDateUuidCursor(last.due_at, last.id, binding) : null,
    };
  },

  async update(
    auth: GroupReminderAuthorization,
    id: string,
    input: GroupReminderUpdateInput,
  ): Promise<ReminderRecord> {
    if (
      input.content === undefined && input.enabled === undefined &&
      input.firstRunAt === undefined && input.recurrence === undefined
    ) {
      throw new AppError("AGENT_REMINDER_UPDATE_INVALID", "Не указаны изменения напоминания");
    }
    const content = input.content === undefined ? undefined : requireReminderContent(input.content);
    const firstRunAt = input.firstRunAt === undefined
      ? undefined
      : requireGroupReminderTime(input.firstRunAt);
    const recurrence = input.recurrence === undefined
      ? undefined
      : requireReminderRecurrence(input.recurrence);
    const inputHash = reminderOperationHash({
      ...input,
      content,
      firstRunAt: firstRunAt?.toISOString(),
    });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const replay = await findReminderOperation(
        client,
        auth.familyId,
        input.operationKey,
        "update",
        inputHash,
      );
      if (replay) {
        const existing = await selectReminder(client, auth.familyId, replay);
        if (!existing) throw reminderNotFound();
        requireOwnGroupReminder(auth, existing);
        await client.query("COMMIT");
        return rowToReminder(existing);
      }
      const reminder = await selectReminder(client, auth.familyId, id, true);
      if (!reminder) throw reminderNotFound();
      requireOwnGroupReminder(auth, reminder);
      const live = reminder.status === "active" || reminder.status === "leased" ||
        reminder.status === "paused";
      if (input.enabled === false && !live) {
        throw new AppError(
          "AGENT_REMINDER_NOT_ACTIVE",
          "Приостановить можно только действующее напоминание",
        );
      }
      // Reviving a completed or failed reminder puts it back among the live ones, so it has to pass
      // the same caps as a new one. Without this, a failed batch would launder extra slots.
      if (input.enabled === true && !live) await requireFreeGroupSlot(client, auth, id);
      const updated = await applyReminderUpdate(client, reminder, {
        ...(content === undefined ? {} : { content }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(firstRunAt === undefined ? {} : { firstRunAt }),
        ...(recurrence === undefined ? {} : { recurrence }),
      });
      await recordReminderOperation(client, {
        familyId: auth.familyId,
        inputHash,
        operationKey: input.operationKey,
        operationKind: "update",
        reminderId: id,
      });
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, NULL, 'reminder.updated', $2,
                 jsonb_build_object('scope', 'group', 'telegramUserId', $3::text))`,
        [auth.familyId, id, auth.telegramUserId],
      );
      await client.query("COMMIT");
      return rowToReminder(updated);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Deletion additionally accepts another participant once Telegram confirms that the author has
   * left the chat: otherwise a departed author would leave an undeletable reminder behind, and a
   * recurring one would keep writing into the chat forever while holding one of its slots.
   */
  async delete(
    auth: GroupReminderAuthorization,
    id: string,
    operationKey: string,
    resolveAuthorPresence: TelegramChatPresenceLookup,
  ): Promise<boolean> {
    // Presence is resolved before any lock and before a pooled connection is held: the lookup is a
    // network call, and the delivery path takes its own `FOR UPDATE` on the same row. Holding the
    // row through it would stall the current dispatch batch for the whole Telegram timeout.
    const author = await requireDeletableGroupReminderAuthor(auth, id, resolveAuthorPresence);
    const inputHash = reminderOperationHash({ id });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const replay = await findReminderOperation(
        client,
        auth.familyId,
        operationKey,
        "delete",
        inputHash,
      );
      if (replay !== undefined) {
        await client.query("COMMIT");
        return true;
      }
      const reminder = await selectReminder(client, auth.familyId, id, true);
      if (!reminder) throw reminderNotFound();
      requireGroupReminderOfThisChat(auth, reminder);
      // The row could have been replaced between the presence answer and this lock, so the verdict
      // is only honoured for the exact author it was given for.
      if (reminder.author_telegram_user_id !== author) {
        throw mutationDenied(
          "Напоминание изменилось, пока проверялся его автор. Повторите удаление",
        );
      }
      requireReminderNotLeased(reminder, "delete");
      await recordReminderOperation(client, {
        familyId: auth.familyId,
        inputHash,
        operationKey,
        operationKind: "delete",
        reminderId: id,
      });
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, NULL, 'reminder.deleted', $2,
                 jsonb_build_object('scope', 'group', 'telegramUserId', $3::text,
                                    'authorTelegramUserId', $4::text))`,
        [auth.familyId, id, auth.telegramUserId, author],
      );
      await client.query("DELETE FROM reminders WHERE id = $1", [id]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
