/**
 * Terminal state for interactive and background memory-review batches.
 *
 * Exports:
 * - `memoryReviewTerminalRepository`: replay-safe completion/failure and pre-Eve source release.
 * - `terminalizeAbandonedReviewTurns`: last-resort exit for a turn that never reports back.
 */
import type { PoolClient } from "pg";

import { SESSION_RETENTION_DAYS } from "../../config.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import {
  MEMORY_REVIEW_ABANDONED_TURN_BATCH_SIZE,
  MEMORY_REVIEW_ABANDONED_TURN_TIMEOUT_MILLISECONDS,
} from "./memory-review-config.js";
import { enqueueMemoryReviewOwnerAlert } from "./memory-review-owner-alert-repository.js";

export type MemoryReviewTerminalResult = "recorded" | "released" | "replayed";
export type MemoryReviewCompletionResult = MemoryReviewTerminalResult | "failed";

const SOURCE_BINDING_MISSING = "AGENT_MEMORY_REVIEW_SOURCE_BINDING_MISSING";
const TURN_ABANDONED = "AGENT_MEMORY_REVIEW_TURN_ABANDONED";

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
        WHERE lane_id = $1 AND predecessor_sequence = $2
          AND status IN ('completed', 'skipped')`,
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

async function retireAbandonedReviewSession(
  client: PoolClient,
  applicationSessionId: string,
  now: Date,
): Promise<void> {
  // Only the background review session is orphaned by an abandoned turn: `retireAbandonedTasks`
  // covers `task` kinds and retention covers retired rows, so nothing else would ever close it,
  // and its bound sources would hold the group timeline against pruning forever. An interactive
  // batch shares the live chat session, whose lifecycle belongs to the Telegram channel.
  const retired = await client.query(
    `UPDATE conversation_sessions
        SET pending_operation = false, task_state = 'failed', retired_at = $2,
            delete_after = $2::timestamptz + $3 * interval '1 day'
      WHERE id = $1 AND kind = 'proactive' AND retired_at IS NULL`,
    [applicationSessionId, now, SESSION_RETENTION_DAYS],
  );
  if (retired.rowCount !== 1) return;
  await client.query(
    `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
     SELECT family_id, 'session.noncanonical_retired', id,
            jsonb_build_object('kind', kind::text, 'taskState', task_state::text)
       FROM conversation_sessions WHERE id = $1`,
    [applicationSessionId],
  );
}

/**
 * A running batch holds no lease: once its turn reaches Eve, the batch waits for that turn's own
 * terminal event and for nothing else. A turn that never reports back — a lost event, a killed
 * process, a restart in the middle of a pass — would hold the lane cursor forever, because
 * `(lane_id, predecessor_sequence)` is unique and only a finished pass moves the cursor.
 *
 * A turn parked for a human answer is alive and is left alone: its application session carries the
 * pending flag until the answer or the timeout arrives. A session removed by retention nulls the
 * batch's reference to it, and such a batch has nothing left to wait for at all.
 *
 * Past the bound, provenance decides rather than the clock. A turn that already wrote memory counts
 * as reviewed, because repeating it would duplicate what it stored. A turn that provably wrote
 * nothing gives its sources back to the unreviewed tail — but only while nothing stands behind it,
 * since later batches chain onto a stuck head and deleting that head would leave them unreachable
 * from the cursor. With a successor present the head is skipped instead: the row stays terminal,
 * the cursor passes through it, and the owner is told which messages no pass will ever see.
 */
export async function terminalizeAbandonedReviewTurns(
  client: PoolClient,
  now: Date,
): Promise<void> {
  const abandoned = await client.query<{
    application_session_id: string | null;
    eve_session_id: string;
    eve_turn_id: string | null;
    from_sequence: string;
    has_successor: boolean;
    id: string;
    lane_id: string;
    through_sequence: string;
  }>(
    `SELECT batch.id, batch.lane_id, batch.application_session_id, batch.eve_session_id,
            batch.eve_turn_id, batch.from_sequence::text, batch.through_sequence::text,
            EXISTS (
              SELECT 1 FROM memory_review_batches AS successor
               WHERE successor.lane_id = batch.lane_id
                 AND successor.predecessor_sequence = batch.through_sequence
            ) AS has_successor
       FROM memory_review_batches AS batch
       LEFT JOIN conversation_sessions AS session ON session.id = batch.application_session_id
      WHERE batch.status = 'running' AND batch.eve_session_id IS NOT NULL
        AND batch.started_at <= $1::timestamptz - $2::double precision * interval '1 millisecond'
        AND (session.id IS NULL OR session.retired_at IS NOT NULL
          OR session.pending_operation = false)
      ORDER BY batch.started_at, batch.id
      FOR UPDATE OF batch SKIP LOCKED
      LIMIT $3`,
    [now, MEMORY_REVIEW_ABANDONED_TURN_TIMEOUT_MILLISECONDS,
      MEMORY_REVIEW_ABANDONED_TURN_BATCH_SIZE],
  );
  for (const batch of abandoned.rows) {
    // A turn writes memory only after `turn.started` bound its id, so a batch without one cannot
    // have written anything and needs no provenance lookup.
    const wrote = batch.eve_turn_id === null
      ? 0
      : (await client.query(
        "SELECT 1 FROM memory_items_all WHERE source = $1 LIMIT 1",
        [`eve:${batch.eve_session_id}:${batch.eve_turn_id}`],
      )).rowCount;
    const outcome = wrote ? "counted" : batch.has_successor ? "skipped" : "released";
    if (batch.application_session_id !== null) {
      await retireAbandonedReviewSession(client, batch.application_session_id, now);
    }
    if (outcome === "released") {
      await client.query("DELETE FROM memory_review_batches WHERE id = $1", [batch.id]);
    } else {
      await client.query(
        `UPDATE memory_review_batches
            SET status = $4::memory_review_batch_status, diagnostic_code = $2,
                completed_at = $3, updated_at = $3, lease_token = NULL, lease_expires_at = NULL
          WHERE id = $1`,
        [batch.id, TURN_ABANDONED, now, outcome === "counted" ? "completed" : "skipped"],
      );
      await advanceCompletedChain(client, batch.lane_id);
      await client.query(
        "DELETE FROM memory_review_batch_sources WHERE batch_id = $1",
        [batch.id],
      );
      // Skipped sources are lost to review for good, which the owner has to hear about. A counted
      // pass did write memory, so it stays an operational record rather than a warning.
      if (outcome === "skipped") {
        await enqueueMemoryReviewOwnerAlert(client, batch.id, TURN_ABANDONED);
      }
    }
    console.error(JSON.stringify({
      batchId: batch.id,
      code: TURN_ABANDONED,
      eveSessionId: batch.eve_session_id,
      eveTurnId: batch.eve_turn_id,
      fromSequence: batch.from_sequence,
      laneId: batch.lane_id,
      outcome,
      throughSequence: batch.through_sequence,
    }));
  }
}

export const memoryReviewTerminalRepository = {
  async completeBatch(input: {
    batchId: string;
    completedAt: Date;
    eveSessionId: string;
    eveTurnId: string;
  }): Promise<MemoryReviewCompletionResult> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const batch = await client.query<{
        application_session_id: string; batch_kind: string; diagnostic_code: string | null;
        eve_session_id: string | null; eve_turn_id: string | null; lane_id: string;
        source_count: number; started_at: Date | null; status: string;
      }>(
        `SELECT lane_id, application_session_id, eve_session_id, eve_turn_id,
                status::text, diagnostic_code, batch_kind::text, source_count, started_at
           FROM memory_review_batches WHERE id = $1 FOR UPDATE`,
        [input.batchId],
      );
      const recorded = batch.rows[0];
      if (!recorded) {
        // A released batch leaves no row: the repeated terminal event describes the same outcome.
        await client.query("COMMIT");
        return "replayed";
      }
      const exactTurn = recorded.eve_session_id === input.eveSessionId &&
        recorded.eve_turn_id === input.eveTurnId;
      if (recorded.status === "completed" && exactTurn) {
        // Eve lifecycle events are at-least-once; an identical terminal replay is a no-op.
        await client.query("COMMIT");
        return "replayed";
      }
      if (recorded.status === "failed" && exactTurn &&
        recorded.diagnostic_code === SOURCE_BINDING_MISSING) {
        await client.query("COMMIT");
        return "failed";
      }
      if (!exactTurn || !["running", "dispatching"].includes(recorded.status)) {
        throw new AppError(
          "AGENT_MEMORY_REVIEW_COMPLETION_INVALID",
          "Пакет проверки памяти завершён с другим результатом или недоступен",
        );
      }

      const sourceBinding = await client.query(
        `SELECT 1 FROM memory_turn_source_sets
          WHERE memory_review_batch_id = $1 AND eve_session_id = $2 AND eve_turn_id = $3`,
        [input.batchId, input.eveSessionId, input.eveTurnId],
      );
      if (sourceBinding.rowCount !== 1) {
        await client.query(
          `UPDATE memory_review_batches
              SET status = 'failed', diagnostic_code = $2, completed_at = $3, updated_at = $3,
                  lease_token = NULL, lease_expires_at = NULL
            WHERE id = $1`,
          [input.batchId, SOURCE_BINDING_MISSING, input.completedAt],
        );
        await terminalizeApplicationSession(client, {
          applicationSessionId: recorded.application_session_id,
          completedAt: input.completedAt,
          eveSessionId: input.eveSessionId,
          outcome: "failed",
        });
        await enqueueMemoryReviewOwnerAlert(client, input.batchId, SOURCE_BINDING_MISSING);
        await client.query("COMMIT");
        return "failed";
      }

      await client.query(
        `UPDATE memory_review_batches
            SET status = 'completed', completed_at = $2, updated_at = $2,
                lease_token = NULL, lease_expires_at = NULL
          WHERE id = $1`,
        [input.batchId, input.completedAt],
      );
      await terminalizeApplicationSession(client, {
        applicationSessionId: recorded.application_session_id,
        completedAt: input.completedAt,
        eveSessionId: input.eveSessionId,
        outcome: "completed",
      });
      await advanceCompletedChain(client, recorded.lane_id);
      await client.query(
        "DELETE FROM memory_review_batch_sources WHERE batch_id = $1",
        [input.batchId],
      );
      // Capture rate per batch is the one number that tells whether review earns its model call.
      const written = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM memory_mutation_operations
          WHERE mutation_kind = 'create' AND eve_session_id = $1 AND eve_turn_id = $2`,
        [input.eveSessionId, input.eveTurnId],
      );
      await client.query("COMMIT");
      console.info(JSON.stringify({
        code: "AGENT_MEMORY_REVIEW_RESULT",
        batchId: input.batchId,
        batchKind: recorded.batch_kind,
        claimsWritten: Number(written.rows[0]?.count ?? 0),
        durationMs: recorded.started_at === null
          ? null
          : input.completedAt.getTime() - recorded.started_at.getTime(),
        eveSessionId: input.eveSessionId,
        eveTurnId: input.eveTurnId,
        sourceCount: recorded.source_count,
      }));
      return "recorded";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * A failed interactive turn keeps the lane blocked, because `(lane_id, predecessor_sequence)` is
   * unique: no later batch can occupy the same cursor. That is correct only when the turn might
   * already have written memory, since a repeat would duplicate it. When the turn provably wrote
   * nothing, the batch is released instead: its sources return to the unreviewed tail and a later
   * turn reviews them normally, so one broken model call cannot stop the group from remembering.
   */
  async failRunning(input: {
    batchId: string;
    diagnosticCode: string;
    eveSessionId: string;
    eveTurnId: string;
  }): Promise<MemoryReviewTerminalResult> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const wrote = await client.query(
        "SELECT 1 FROM memory_items_all WHERE source = $1 LIMIT 1",
        [`eve:${input.eveSessionId}:${input.eveTurnId}`],
      );
      if (!wrote.rowCount) {
        const released = await client.query<{ application_session_id: string }>(
          `DELETE FROM memory_review_batches
            WHERE id = $1 AND status = 'running' AND eve_session_id = $2
            RETURNING application_session_id`,
          [input.batchId, input.eveSessionId],
        );
        if (released.rowCount === 1) {
          await terminalizeApplicationSession(client, {
            applicationSessionId: released.rows[0]!.application_session_id,
            completedAt: new Date(),
            eveSessionId: input.eveSessionId,
            outcome: "failed",
          });
          console.error(JSON.stringify({
            batchId: input.batchId,
            code: "AGENT_MEMORY_REVIEW_BATCH_RELEASED",
            diagnosticCode: input.diagnosticCode,
          }));
          await client.query("COMMIT");
          return "released";
        }
      }
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
        // A released batch leaves no row: the repeated failure event describes the same outcome.
        if (!terminal) {
          await client.query("COMMIT");
          return "replayed";
        }
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
