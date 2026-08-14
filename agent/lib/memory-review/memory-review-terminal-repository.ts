/**
 * Terminal preparation state for interactive memory-review batches.
 *
 * Export:
 * - `memoryReviewTerminalRepository`: replay-safe completion/failure and pre-Eve source release.
 */
import type { PoolClient } from "pg";

import { SESSION_RETENTION_DAYS } from "../../config.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { enqueueMemoryReviewOwnerAlert } from "./memory-review-owner-alert-repository.js";

export type MemoryReviewTerminalResult = "recorded" | "replayed";

async function advanceCompletedChain(client: PoolClient, laneId: string): Promise<void> {
  const lane = await client.query<{ processed_through_sequence: string }>(
    `SELECT processed_through_sequence::text FROM memory_review_lanes
      WHERE id = $1 FOR UPDATE`,
    [laneId],
  );
  let cursor = lane.rows[0]!.processed_through_sequence;
  while (true) {
    const next = await client.query<{ through_sequence: string }>(
      `SELECT through_sequence::text FROM memory_review_batches
        WHERE lane_id = $1 AND predecessor_sequence = $2 AND status = 'completed'`,
      [laneId, cursor],
    );
    const through = next.rows[0]?.through_sequence;
    if (!through) break;
    cursor = through;
  }
  await client.query(
    `UPDATE memory_review_lanes SET processed_through_sequence = $2, updated_at = now()
      WHERE id = $1`,
    [laneId, cursor],
  );
}

async function terminalizeApplicationSession(
  client: PoolClient,
  input: {
    applicationSessionId: string;
    completedAt: Date;
    eveSessionId: string;
    outcome: "completed" | "failed";
  },
): Promise<void> {
  const result = await client.query(
    `UPDATE conversation_sessions
        SET completed_turns = completed_turns + CASE WHEN $4 = 'completed' THEN 1 ELSE 0 END,
            last_activity_at = $3, pending_operation = false, eve_session_id = $2,
            task_state = CASE
              WHEN kind <> 'canonical' THEN $4::conversation_task_state
              ELSE task_state
            END,
            retired_at = CASE WHEN kind <> 'canonical' THEN $3 ELSE retired_at END,
            delete_after = CASE
              WHEN kind <> 'canonical' THEN $3 + $5 * interval '1 day'
              ELSE delete_after
            END
      WHERE id = $1 AND retired_at IS NULL
        AND (eve_session_id IS NULL OR eve_session_id = $2)`,
    [input.applicationSessionId, input.eveSessionId, input.completedAt, input.outcome,
      SESSION_RETENTION_DAYS],
  );
  if (result.rowCount !== 1) throw new AppError(
    "AGENT_MEMORY_REVIEW_SESSION_TERMINAL_INVALID",
    "Не удалось завершить контекст проверки памяти",
  );
  // Review sessions have no route, but retain the standard noncanonical retirement audit contract.
  await client.query(
    `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
     SELECT family_id, 'session.noncanonical_retired', id,
            jsonb_build_object('kind', kind::text, 'taskState', task_state::text)
       FROM conversation_sessions
      WHERE id = $1 AND retired_at IS NOT NULL AND kind <> 'canonical'`,
    [input.applicationSessionId],
  );
}

export const memoryReviewTerminalRepository = {
  async completeBatch(input: {
    batchId: string;
    completedAt: Date;
    eveSessionId: string;
    eveTurnId: string;
  }): Promise<MemoryReviewTerminalResult> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const batch = await client.query<{
        application_session_id: string; eve_session_id: string; lane_id: string;
      }>(
        `UPDATE memory_review_batches
            SET status = 'completed', completed_at = $2, updated_at = $2,
                lease_token = NULL, lease_expires_at = NULL
          WHERE id = $1 AND status IN ('running', 'dispatching')
            AND eve_session_id = $3 AND eve_turn_id = $4
          RETURNING lane_id, application_session_id, eve_session_id`,
        [input.batchId, input.completedAt, input.eveSessionId, input.eveTurnId],
      );
      if (batch.rowCount !== 1) {
        // Eve lifecycle events are at-least-once; an identical terminal replay is a no-op.
        const replay = await client.query<{ status: string }>(
          "SELECT status::text FROM memory_review_batches WHERE id = $1 FOR UPDATE",
          [input.batchId],
        );
        if (replay.rows[0]?.status !== "completed") throw new AppError(
          "AGENT_MEMORY_REVIEW_COMPLETION_INVALID",
          "Пакет проверки памяти завершён с другим результатом или недоступен",
        );
        await client.query("COMMIT");
        return "replayed";
      }
      const recorded = batch.rows[0]!;
      await terminalizeApplicationSession(client, {
        applicationSessionId: recorded.application_session_id,
        completedAt: input.completedAt,
        eveSessionId: recorded.eve_session_id,
        outcome: "completed",
      });
      await advanceCompletedChain(client, recorded.lane_id);
      await client.query(
        "DELETE FROM memory_review_batch_sources WHERE batch_id = $1",
        [input.batchId],
      );
      await client.query("COMMIT");
      return "recorded";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async failRunning(input: {
    batchId: string;
    diagnosticCode: string;
    eveSessionId: string;
  }): Promise<MemoryReviewTerminalResult> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ application_session_id: string }>(
        `UPDATE memory_review_batches
            SET status = 'failed', diagnostic_code = $3, completed_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'running' AND eve_session_id = $2
          RETURNING application_session_id`,
        [input.batchId, input.eveSessionId, input.diagnosticCode],
      );
      if (result.rowCount !== 1) {
        // Conflicting terminal results fail closed; only the exact failure event is replay-safe.
        const replay = await client.query<{
          diagnostic_code: string | null; eve_session_id: string | null; status: string;
        }>(
          `SELECT status::text, diagnostic_code, eve_session_id
             FROM memory_review_batches WHERE id = $1 FOR UPDATE`,
          [input.batchId],
        );
        const terminal = replay.rows[0];
        const sameFailure = terminal?.status === "failed" &&
          terminal.eve_session_id === input.eveSessionId &&
          terminal.diagnostic_code === input.diagnosticCode;
        if (!sameFailure) throw new AppError(
          "AGENT_MEMORY_REVIEW_FAILURE_STATE_INVALID",
          "Проверка памяти завершена с другим результатом или недоступна",
        );
        await client.query("COMMIT");
        return "replayed";
      }
      await terminalizeApplicationSession(client, {
        applicationSessionId: result.rows[0]!.application_session_id,
        completedAt: new Date(),
        eveSessionId: input.eveSessionId,
        outcome: "failed",
      });
      // Terminal failures retain exact sources so an operator can prove and perform a later repair.
      await enqueueMemoryReviewOwnerAlert(client, input.batchId, input.diagnosticCode);
      await client.query("COMMIT");
      return "recorded";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async failInteractivePreparation(batchId: string, diagnosticCode: string): Promise<void> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE memory_review_batches
            SET status = 'failed', diagnostic_code = $2, completed_at = now(), updated_at = now()
          WHERE id = $1 AND batch_kind = 'interactive' AND status = 'running'
            AND eve_session_id IS NULL`,
        [batchId, diagnosticCode],
      );
      if (result.rowCount === 1) {
        await enqueueMemoryReviewOwnerAlert(client, batchId, diagnosticCode);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
