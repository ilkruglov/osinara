/**
 * External-group reminder rules shared by the repository operations.
 *
 * Exports:
 * - `GROUP_REMINDER_LIVE_STATUSES`: the statuses that occupy one of the group slots.
 * - `reminderNotFound`, `mutationDenied`: the two refusals a participant can receive.
 * - `requireGroupReminderOfThisChat`, `requireOwnGroupReminder`: visibility and authorship.
 * - `requireGroupReminderTime`: the accepted first-run window of a public chat.
 * - `requireGroupReminderDestination`: live registration of the verified current chat.
 * - `requireFreeGroupSlot`: both caps under one per-group lock.
 *
 * Key construct:
 * - Rules live apart from the SQL flow so create, revival and deletion cannot drift into three
 *   slightly different notions of who may act and what still counts as a live reminder.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import type { GroupReminderAuthorization } from "./group-reminder-context.js";
import {
  GROUP_REMINDER_MAX_BACKDATE_MS,
  GROUP_REMINDER_MAX_PER_AUTHOR,
  GROUP_REMINDER_MAX_PER_CHAT,
} from "./reminder-config.js";
import type { MutableReminderRow } from "./reminder-repository-helpers.js";
import { requireReminderDate } from "./reminder-validation.js";

/** A delivered one-time reminder frees its slot; active, paused and in-flight ones hold theirs. */
export const GROUP_REMINDER_LIVE_STATUSES = "('active', 'leased', 'paused')";

export function reminderNotFound(): AppError {
  return new AppError("AGENT_REMINDER_NOT_FOUND", "Напоминание не найдено");
}

export function mutationDenied(message: string): AppError {
  return new AppError("AGENT_REMINDER_MUTATION_DENIED", message);
}

/**
 * A reminder of another chat stays invisible rather than merely unchangeable: the participant must
 * not learn that it exists.
 */
export function requireGroupReminderOfThisChat(
  auth: GroupReminderAuthorization,
  reminder: Pick<MutableReminderRow, "group_id" | "scope">,
): void {
  if (reminder.scope !== "group" || reminder.group_id !== auth.groupId) throw reminderNotFound();
}

export function requireOwnGroupReminder(
  auth: GroupReminderAuthorization,
  reminder: Pick<MutableReminderRow, "author_telegram_user_id" | "group_id" | "scope">,
): void {
  requireGroupReminderOfThisChat(auth, reminder);
  if (reminder.author_telegram_user_id !== auth.telegramUserId) {
    throw mutationDenied("Изменить или удалить напоминание может только тот, кто его создал");
  }
}

export function requireGroupReminderTime(firstRunAt: Date): Date {
  const validated = requireReminderDate(firstRunAt);
  if (validated.getTime() < Date.now() - GROUP_REMINDER_MAX_BACKDATE_MS) {
    throw new AppError(
      "AGENT_REMINDER_GROUP_TIME_TOO_OLD",
      "Это время уже прошло. Укажите время напоминания в будущем",
    );
  }
  return validated;
}

export async function requireGroupReminderDestination(
  client: PoolClient,
  auth: GroupReminderAuthorization,
): Promise<void> {
  const group = await client.query(
    `SELECT 1 FROM telegram_groups
     WHERE id = $1 AND family_id = $2 AND telegram_chat_id = $3 AND type = 'external'`,
    [auth.groupId, auth.familyId, auth.telegramChatId],
  );
  if (!group.rowCount) {
    throw new AppError(
      "AGENT_REMINDER_DESTINATION_INVALID",
      "Эта группа больше не подключена как внешняя, напоминание создать нельзя",
    );
  }
}

/**
 * Both caps are enforced here under one per-group lock, so counting and the write that follows it
 * cannot interleave with another participant. `excludeId` keeps a revived reminder from counting
 * itself when it is already live.
 */
export async function requireFreeGroupSlot(
  client: PoolClient,
  auth: GroupReminderAuthorization,
  excludeId: string | null,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('osinara-group-reminders:' || $1::text, 0))",
    [auth.groupId],
  );
  const counts = await client.query<{ mine: string; total: string }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE author_telegram_user_id = $2) AS mine
     FROM reminders
     WHERE scope = 'group' AND group_id = $1 AND status IN ${GROUP_REMINDER_LIVE_STATUSES}
       AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [auth.groupId, auth.telegramUserId, excludeId],
  );
  if (Number(counts.rows[0]!.mine) >= GROUP_REMINDER_MAX_PER_AUTHOR) {
    throw new AppError(
      "AGENT_REMINDER_GROUP_AUTHOR_LIMIT",
      `Вы уже поставили в этом чате максимум напоминаний (${GROUP_REMINDER_MAX_PER_AUTHOR}). ` +
        "Удалите одно из них, чтобы поставить новое",
    );
  }
  if (Number(counts.rows[0]!.total) >= GROUP_REMINDER_MAX_PER_CHAT) {
    throw new AppError(
      "AGENT_REMINDER_GROUP_CHAT_LIMIT",
      `В этом чате уже стоит максимум напоминаний (${GROUP_REMINDER_MAX_PER_CHAT}). ` +
        "Новое можно поставить после того, как участники удалят ненужные",
    );
  }
}
