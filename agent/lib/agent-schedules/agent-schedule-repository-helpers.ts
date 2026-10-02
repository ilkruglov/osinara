/**
 * PostgreSQL helpers for agent schedule CRUD and dispatcher repositories.
 *
 * Exports:
 * - `agentScheduleColumns` and `AGENT_SCHEDULE_COLUMNS`: qualified and plain row projections.
 * - Replay, idempotency-lock, row-lock, and mutation authorization helpers.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { requireCurrentMembership } from "../family-repository-checks.js";
import type { AgentScheduleAuthorization } from "./agent-schedule-context.js";
import type { AgentScheduleRow } from "./agent-schedule-record.js";

export interface MutableAgentScheduleRow extends AgentScheduleRow {
  author_user_id: string;
  family_id: string;
  group_id: string | null;
  occurrence_index: number;
  owner_user_id: string | null;
  recurrence_anchor_local: Date;
  telegram_chat_id: string;
  telegram_chat_type: "group" | "private" | "supergroup";
}

export function agentScheduleColumns(qualifier?: string): string {
  const column = (name: string) => qualifier === undefined ? name : `${qualifier}.${name}`;
  return `${column("id")}, ${column("scope")}, ${column("title")}, ${column("user_request")}, ${column("scenario_prompt")},
  ${column("timezone")}, ${column("recurrence_kind")}, ${column("recurrence_interval")}, ${column("recurrence_days_of_week")},
  ${column("next_run_at")}, ${column("status")}, ${column("message_thread_id")}::text, ${column("forum_topic_id")}::text,
  ${column("history_window_days")}, ${column("tool_allowlist")}, ${column("last_error_code")}, ${column("created_at")}, ${column("updated_at")}`;
}

export const AGENT_SCHEDULE_COLUMNS = agentScheduleColumns();

export async function findAgentScheduleOperation(
  client: PoolClient,
  auth: AgentScheduleAuthorization,
  operationKey: string,
  operationKind: "create" | "delete" | "run_now" | "update",
  inputHash: string,
): Promise<string | null | undefined> {
  const result = await client.query<{
    input_hash: string;
    operation_kind: string;
    schedule_id: string | null;
  }>(
    `SELECT operation_kind, input_hash, schedule_id
     FROM agent_schedule_operations WHERE family_id = $1 AND operation_key = $2`,
    [auth.familyId, operationKey],
  );
  const operation = result.rows[0];
  if (!operation) return undefined;
  if (operation.operation_kind !== operationKind || operation.input_hash !== inputHash) {
    throw new AppError(
      "AGENT_SCHEDULE_OPERATION_CONFLICT",
      "Повтор операции агентного расписания содержит другие параметры",
    );
  }
  return operation.schedule_id;
}

export async function lockAgentScheduleOperation(
  client: PoolClient,
  auth: AgentScheduleAuthorization,
  operationKey: string,
): Promise<void> {
  // PostgreSQL row locks cannot serialize a not-yet-created operation row.
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))",
    [auth.familyId, operationKey],
  );
}

export async function selectAgentSchedule(
  client: PoolClient,
  familyId: string,
  id: string,
  lock = false,
): Promise<MutableAgentScheduleRow | null> {
  const result = await client.query<MutableAgentScheduleRow>(
    `SELECT ${AGENT_SCHEDULE_COLUMNS}, family_id, owner_user_id, author_user_id,
            group_id, occurrence_index, recurrence_anchor_local,
            telegram_chat_id, telegram_chat_type
       FROM agent_schedules WHERE family_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
    [familyId, id],
  );
  return result.rows[0] ?? null;
}

/**
 * Whether the current chat may see a schedule at all. A personal schedule carries its owner's
 * scenario prompt and request: private text that must not enter the family group's context even
 * when the owner asks there. The audience rule precedes every author or role check.
 */
export function agentScheduleVisibleInChat(
  auth: Pick<AgentScheduleAuthorization, "telegramChatType">,
  schedule: { scope: string },
): boolean {
  return schedule.scope !== "personal" || auth.telegramChatType === "private";
}

export async function requireAgentScheduleMutationAccess(
  client: PoolClient,
  auth: AgentScheduleAuthorization,
  schedule: MutableAgentScheduleRow,
): Promise<void> {
  if (!agentScheduleVisibleInChat(auth, schedule)) {
    throw new AppError("AGENT_SCHEDULE_NOT_FOUND", "Агентное расписание не найдено");
  }
  const role = await requireCurrentMembership(client, auth);
  const allowed = schedule.scope === "personal"
    ? schedule.author_user_id === auth.userId
    : schedule.scope === "family"
      ? schedule.author_user_id === auth.userId || role === "owner"
      : role === "owner" && auth.telegramChatType === "private";
  if (!allowed) {
    throw new AppError(
      "AGENT_SCHEDULE_MUTATION_DENIED",
      "Изменить семейное агентное расписание может только его автор или владелец семьи",
    );
  }
}
