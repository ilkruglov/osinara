/**
 * Owner-side administration of public-chat reminders.
 *
 * Exports:
 * - `OwnerGroupReminderSummary`: what the owner sees about one reminder of a registered chat.
 * - `ownerGroupReminderAdministration`: list and delete reminders of one external group.
 *
 * Key construct:
 * - Deletion inside the public chat needs the author, and a departed author can only be recognised
 *   through Telegram, which does not guarantee that answer unless the bot is an administrator
 *   there. This boundary is the door that always works: the owner names the registered chat in
 *   their private chat and removes the record on their own authority, without any presence lookup.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { PrivateTelegramOwner } from "../family-context.js";
import { GROUP_REMINDER_LIVE_STATUSES } from "./group-reminder-policy.js";
import {
  type ReminderRecurrence,
  type ReminderStatus,
  reminderOperationHash,
} from "./reminder-record.js";
import { findReminderOperation } from "./reminder-repository-helpers.js";
import { recordReminderOperation, requireReminderNotLeased } from "./reminder-mutation.js";

export interface OwnerGroupReminderSummary {
  authorTelegramUserId: string;
  content: string;
  id: string;
  nextRunAt: string;
  recurrence: ReminderRecurrence | null;
  status: ReminderStatus;
  timezone: string;
}

interface OwnerGroupRow {
  author_telegram_user_id: string;
  content: string;
  due_at: Date;
  id: string;
  recurrence_interval: number | null;
  recurrence_unit: ReminderRecurrence["unit"] | null;
  status: ReminderStatus;
  timezone: string;
}

function summary(row: OwnerGroupRow): OwnerGroupReminderSummary {
  return {
    authorTelegramUserId: row.author_telegram_user_id,
    content: row.content,
    id: row.id,
    nextRunAt: row.due_at.toISOString(),
    recurrence: row.recurrence_unit && row.recurrence_interval
      ? { interval: row.recurrence_interval, unit: row.recurrence_unit }
      : null,
    status: row.status,
    timezone: row.timezone,
  };
}

async function requireOwnedExternalGroup(
  client: PoolClient,
  owner: Pick<PrivateTelegramOwner, "familyId">,
  telegramChatId: string,
): Promise<string> {
  const group = await client.query<{ id: string }>(
    `SELECT id FROM telegram_groups
     WHERE family_id = $1 AND telegram_chat_id = $2 AND type = 'external'`,
    [owner.familyId, telegramChatId],
  );
  const groupId = group.rows[0]?.id;
  if (typeof groupId !== "string") {
    throw new AppError(
      "AGENT_REMINDER_GROUP_NOT_REGISTERED",
      "Этот чат не подключён к агенту как внешняя группа",
    );
  }
  return groupId;
}

export const ownerGroupReminderAdministration = {
  async list(
    owner: PrivateTelegramOwner,
    telegramChatId: string,
  ): Promise<{ items: OwnerGroupReminderSummary[] }> {
    const client = await database().connect();
    try {
      const groupId = await requireOwnedExternalGroup(client, owner, telegramChatId);
      const result = await client.query<OwnerGroupRow>(
        `SELECT id, content, timezone, due_at, status, recurrence_unit, recurrence_interval,
                author_telegram_user_id
         FROM reminders
         WHERE scope = 'group' AND group_id = $1 AND status IN ${GROUP_REMINDER_LIVE_STATUSES}
         ORDER BY due_at, id`,
        [groupId],
      );
      return { items: result.rows.map(summary) };
    } finally {
      client.release();
    }
  },

  async delete(
    owner: PrivateTelegramOwner,
    telegramChatId: string,
    reminderId: string,
    operationKey: string,
  ): Promise<boolean> {
    const inputHash = reminderOperationHash({ id: reminderId, telegramChatId });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const replay = await findReminderOperation(
        client,
        owner.familyId,
        operationKey,
        "delete",
        inputHash,
      );
      if (replay !== undefined) {
        await client.query("COMMIT");
        return true;
      }
      const groupId = await requireOwnedExternalGroup(client, owner, telegramChatId);
      const found = await client.query<{ status: ReminderStatus }>(
        `SELECT status FROM reminders
         WHERE id = $1 AND family_id = $2 AND group_id = $3 AND scope = 'group'
         FOR UPDATE`,
        [reminderId, owner.familyId, groupId],
      );
      const reminder = found.rows[0];
      if (!reminder) {
        throw new AppError(
          "AGENT_REMINDER_NOT_FOUND",
          "Напоминание этого чата не найдено. Обновите список и повторите",
        );
      }
      requireReminderNotLeased(reminder, "delete");
      await recordReminderOperation(client, {
        familyId: owner.familyId,
        inputHash,
        operationKey,
        operationKind: "delete",
        reminderId,
      });
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'reminder.deleted', $3,
                 jsonb_build_object('scope', 'group', 'byOwner', true,
                                    'telegramChatId', $4::text))`,
        [owner.familyId, owner.userId, reminderId, telegramChatId],
      );
      await client.query("DELETE FROM reminders WHERE id = $1", [reminderId]);
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
