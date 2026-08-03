/**
 * PostgreSQL persistence for Eve session lifecycle events.
 *
 * Export:
 * - `sessionLifecycleEventRepository`: Eve binding, completion/failure, and rotation requests.
 */
import { SESSION_RETENTION_DAYS } from "../../config.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { classifyMissedSessionEvent, type SessionEventResult } from "./session-eve-event.js";

async function recordRetirementAudit(id: string): Promise<void> {
  // Canonical sessions rotate separately; this audit covers terminal task/scheduled/proactive rows.
  await database().query(
    `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
     SELECT family_id, 'session.noncanonical_retired', id,
            jsonb_build_object('kind', kind::text, 'taskState', task_state::text)
       FROM conversation_sessions
      WHERE id = $1 AND retired_at IS NOT NULL AND kind <> 'canonical'`,
    [id],
  );
}

export const sessionLifecycleEventRepository = {
  async hasPendingOperation(id: string, eveSessionId: string): Promise<boolean> {
    const result = await database().query<{ pending: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM conversation_sessions
          WHERE id = $1 AND eve_session_id = $2
            AND pending_operation = true AND retired_at IS NULL
       ) AS pending`,
      [id, eveSessionId],
    );
    return result.rows[0]?.pending === true;
  },

  async bindEveSession(id: string, eveSessionId: string): Promise<SessionEventResult> {
    const result = await database().query(
      `UPDATE conversation_sessions
           SET eve_session_id = $2
         WHERE id = $1 AND retired_at IS NULL
           AND (eve_session_id IS NULL OR eve_session_id <= $2)`,
      [id, eveSessionId],
    );
    if (result.rowCount === 1) return "recorded";
    return await classifyMissedSessionEvent(
      id,
      eveSessionId,
      "AGENT_SESSION_BIND_FAILED",
      "Не удалось связать текущий контекст с Eve",
    );
  },

  async markPendingOperation(id: string, pending: boolean): Promise<void> {
    const result = await database().query(
      "UPDATE conversation_sessions SET pending_operation = $2 WHERE id = $1 AND retired_at IS NULL",
      [id, pending],
    );
    if (result.rowCount === 1) return;
    throw new AppError("AGENT_SESSION_NOT_ACTIVE", "Текущий контекст уже завершён");
  },

  async resumePendingSession(id: string, eveSessionId: string): Promise<void> {
    const result = await database().query(
      `UPDATE conversation_sessions
          SET pending_operation = false,
              pending_request_id = NULL,
              task_state = CASE
                WHEN kind <> 'canonical' THEN 'running'::conversation_task_state
                ELSE task_state
              END
        WHERE id = $1 AND eve_session_id = $2 AND retired_at IS NULL`,
      [id, eveSessionId],
    );
    if (result.rowCount !== 1) {
      throw new AppError(
        "AGENT_SESSION_RESUME_STATE_FAILED",
        "Не удалось обновить состояние продолжаемого действия",
      );
    }
  },

  async recordTurnCompleted(
    id: string,
    eveSessionId: string,
    pendingOperation: boolean,
  ): Promise<SessionEventResult> {
    const result = await database().query(
      `UPDATE conversation_sessions
          SET completed_turns = completed_turns + 1,
              last_activity_at = now(), pending_operation = $3,
              eve_session_id = $2,
              task_state = CASE
                WHEN kind <> 'canonical' AND $3 THEN 'pending'::conversation_task_state
                WHEN kind <> 'canonical' THEN 'completed'::conversation_task_state
                ELSE task_state
              END,
              retired_at = CASE WHEN kind <> 'canonical' AND NOT $3 THEN now() ELSE retired_at END,
              delete_after = CASE
                WHEN kind <> 'canonical' AND NOT $3 THEN now() + $4 * interval '1 day'
                ELSE delete_after
              END
        WHERE id = $1 AND retired_at IS NULL
           AND (eve_session_id IS NULL OR eve_session_id <= $2)`,
      [id, eveSessionId, pendingOperation, SESSION_RETENTION_DAYS],
    );
    if (result.rowCount === 1) {
      await database().query(
        `DELETE FROM conversation_session_routes route
          WHERE route.session_id = $1
            AND EXISTS (
              SELECT 1 FROM conversation_sessions session
               WHERE session.id = route.session_id AND session.retired_at IS NOT NULL
            )`,
        [id],
      );
      await recordRetirementAudit(id);
      return "recorded";
    }
    return await classifyMissedSessionEvent(
      id,
      eveSessionId,
      "AGENT_SESSION_TURN_RECORD_FAILED",
      "Не удалось сохранить завершённый ход",
    );
  },

  async recordTurnFailed(id: string, eveSessionId: string): Promise<SessionEventResult> {
    const result = await database().query(
      `UPDATE conversation_sessions
          SET pending_operation = false, eve_session_id = $2,
              task_state = CASE
                WHEN kind <> 'canonical' THEN 'failed'::conversation_task_state
                ELSE task_state
              END,
              retired_at = CASE WHEN kind <> 'canonical' THEN now() ELSE retired_at END,
              delete_after = CASE
                WHEN kind <> 'canonical' THEN now() + $3 * interval '1 day'
                ELSE delete_after
              END
        WHERE id = $1 AND retired_at IS NULL
           AND (eve_session_id IS NULL OR eve_session_id <= $2)`,
      [id, eveSessionId, SESSION_RETENTION_DAYS],
    );
    if (result.rowCount === 1) {
      await database().query(
        `DELETE FROM conversation_session_routes route
          WHERE route.session_id = $1
            AND EXISTS (
              SELECT 1 FROM conversation_sessions session
               WHERE session.id = route.session_id AND session.retired_at IS NOT NULL
            )`,
        [id],
      );
      await recordRetirementAudit(id);
      return "recorded";
    }
    return await classifyMissedSessionEvent(
      id,
      eveSessionId,
      "AGENT_SESSION_FAILURE_RECORD_FAILED",
      "Не удалось сохранить состояние контекста",
    );
  },

  async recordSessionFailedByContinuationToken(
    continuationToken: string,
    eveSessionId: string,
  ): Promise<SessionEventResult> {
    // Resolve both Eve's current token and the exact prompt route retained for a pending task.
    const sessions = await database().query<{ id: string }>(
      `SELECT DISTINCT s.id
         FROM conversation_sessions s
         LEFT JOIN conversation_session_routes r ON r.session_id = s.id
        WHERE s.retired_at IS NULL
          AND (s.continuation_token = $1 OR r.base_continuation_token = $1)`,
      [continuationToken],
    );
    if (sessions.rowCount !== 1) {
      throw new AppError(
        "AGENT_SESSION_FAILURE_RECORD_FAILED",
        sessions.rowCount === 0
          ? "Не удалось завершить повреждённый контекст"
          : "Маршрут повреждённого контекста связан с несколькими сессиями",
      );
    }
    const id = sessions.rows[0]!.id;
    const result = await database().query(
      `UPDATE conversation_sessions
           SET pending_operation = false,
               rotation_requested_at = CASE WHEN kind = 'canonical' THEN now() ELSE rotation_requested_at END,
               eve_session_id = $2,
               task_state = CASE WHEN kind <> 'canonical' THEN 'failed'::conversation_task_state ELSE task_state END,
               retired_at = CASE WHEN kind <> 'canonical' THEN now() ELSE retired_at END,
               delete_after = CASE
                 WHEN kind <> 'canonical' THEN now() + $3 * interval '1 day'
                 ELSE delete_after
               END
        WHERE id = $1 AND retired_at IS NULL
          AND (eve_session_id IS NULL OR eve_session_id <= $2)`,
      [id, eveSessionId, SESSION_RETENTION_DAYS],
    );
    if (result.rowCount === 1) {
      await database().query(
        `DELETE FROM conversation_session_routes route
          WHERE route.session_id = $1
            AND EXISTS (
              SELECT 1 FROM conversation_sessions session
               WHERE session.id = route.session_id AND session.retired_at IS NOT NULL
            )`,
        [id],
      );
      await recordRetirementAudit(id);
      return "recorded";
    }
    return await classifyMissedSessionEvent(
      id,
      eveSessionId,
      "AGENT_SESSION_FAILURE_RECORD_FAILED",
      "Не удалось сохранить состояние повреждённого контекста",
    );
  },

  async requestRotation(id: string): Promise<void> {
    const result = await database().query(
      "UPDATE conversation_sessions SET rotation_requested_at = now() WHERE id = $1 AND retired_at IS NULL",
      [id],
    );
    if (result.rowCount !== 1) {
      throw new AppError("AGENT_SESSION_NOT_ACTIVE", "Текущий контекст уже завершён");
    }
  },
};
