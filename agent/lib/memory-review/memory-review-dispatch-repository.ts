/**
 * PostgreSQL dispatch state for silent memory-review batches.
 *
 * Export:
 * - `memoryReviewDispatchRepository`: leasing and exact pre/post Eve handoff transitions.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { PoolClient } from "pg";
import { SESSION_RETENTION_DAYS } from "../../config.js";
import type { TelegramGroupJournalEntry } from "../telegram-group-journal-context.js";
import {
  MEMORY_REVIEW_BATCH_SIZE,
  MEMORY_REVIEW_INTERACTIVE_START_TIMEOUT_MILLISECONDS,
} from "./memory-review-config.js";
import { formatMemoryReviewBatchPrompt } from "./memory-review-prompt.js";
import type { MemoryReviewClaim } from "./memory-review-repository.js";

interface SourceRow {
  actor_id: string;
  actor_kind: "agent_self" | "user";
  content_text: string | null;
  id: string;
  message_kind: string;
  message_thread_id: string | null;
  reply_to_sequence_id: string | null;
  sender_display_name: string | null;
  sender_username: string | null;
  sent_at: Date;
  sequence_id: string;
}

function project(row: SourceRow): TelegramGroupJournalEntry {
  return {
    actorId: row.actor_id,
    actorKind: row.actor_kind,
    contentText: row.content_text,
    entryId: row.id,
    messageKind: row.message_kind,
    messageThreadId: row.message_thread_id,
    replyToSequenceId: row.reply_to_sequence_id,
    senderDisplayName: row.sender_display_name,
    senderUsername: row.sender_username,
    sentAt: row.sent_at.toISOString(),
    sequenceId: row.sequence_id,
  };
}

async function materializeReadyBatches(client: PoolClient): Promise<void> {
  // This is the crash-recovery path for a committed 50th message whose inline observer did not run.
  const lanes = await client.query<{
    conversation_id: string;
    id: string;
    message_thread_id: string | null;
    processed_through_sequence: string;
  }>(
    `SELECT id, conversation_id, message_thread_id::text, processed_through_sequence::text
       FROM memory_review_lanes ORDER BY created_at, id FOR UPDATE`,
  );
  for (const lane of lanes.rows) {
    const existing = await client.query<{ status: string; through_sequence: string }>(
      `SELECT status::text, through_sequence::text FROM memory_review_batches
        WHERE lane_id = $1 AND predecessor_sequence = $2`,
      [lane.id, lane.processed_through_sequence],
    );
    if (existing.rows[0]) continue;
    const sources = await client.query<{ id: string; sequence_id: string }>(
      `SELECT message.id, message.sequence_id::text
         FROM telegram_group_messages AS message
        WHERE message.conversation_id = $1 AND message.actor_kind = 'user'
          AND message.message_thread_id IS NOT DISTINCT FROM $2::bigint
          AND message.sequence_id > $3::bigint
        ORDER BY message.sequence_id LIMIT $4`,
      [lane.conversation_id, lane.message_thread_id, lane.processed_through_sequence,
        MEMORY_REVIEW_BATCH_SIZE],
    );
    if (sources.rows.length < MEMORY_REVIEW_BATCH_SIZE) continue;
    const first = sources.rows[0]!;
    const last = sources.rows.at(-1)!;
    const batch = await client.query<{ id: string }>(
      `INSERT INTO memory_review_batches
         (lane_id, conversation_id, batch_kind, status, predecessor_sequence,
          from_sequence, through_sequence, source_count)
       VALUES ($1, $2, 'background', 'pending', $3, $4, $5, $6) RETURNING id`,
      [lane.id, lane.conversation_id, lane.processed_through_sequence,
        first.sequence_id, last.sequence_id, sources.rows.length],
    );
    await client.query(
      `INSERT INTO memory_review_batch_sources
         (batch_id, conversation_id, timeline_entry_id, timeline_sequence)
       SELECT $1, $2, source.id, source.sequence_id
         FROM unnest($3::uuid[], $4::bigint[]) AS source(id, sequence_id)`,
      [batch.rows[0]!.id, lane.conversation_id, sources.rows.map((source) => source.id),
        sources.rows.map((source) => source.sequence_id)],
    );
  }
}

async function terminalizeStaleInteractiveBatches(client: PoolClient, now: Date): Promise<void> {
  // A committed batch without an Eve session may have crossed an ambiguous process-crash boundary.
  const stale = await client.query<{ id: string }>(
    `UPDATE memory_review_batches
        SET status = 'ambiguous',
            diagnostic_code = 'AGENT_MEMORY_REVIEW_INTERACTIVE_START_AMBIGUOUS',
            completed_at = $1, updated_at = $1
      WHERE batch_kind = 'interactive' AND status = 'running' AND eve_session_id IS NULL
        AND started_at <= $1::timestamptz - $2::double precision * interval '1 millisecond'
      RETURNING id`,
    [now, MEMORY_REVIEW_INTERACTIVE_START_TIMEOUT_MILLISECONDS],
  );
  if (stale.rows.length === 0) return;
  await client.query(
    "DELETE FROM memory_review_batch_sources WHERE batch_id = ANY($1::uuid[])",
    [stale.rows.map((row) => row.id)],
  );
}

async function terminalizeStaleDispatchingBatches(client: PoolClient, now: Date): Promise<void> {
  // A handoff that outlives its lease may already have reached Eve, so it is terminally ambiguous.
  const stale = await client.query<{ application_session_id: string; id: string }>(
    `UPDATE memory_review_batches
        SET status = 'ambiguous',
            diagnostic_code = 'AGENT_MEMORY_REVIEW_DISPATCH_TIMEOUT_AMBIGUOUS',
            completed_at = $1, updated_at = $1, lease_token = NULL, lease_expires_at = NULL
      WHERE batch_kind = 'background' AND status = 'dispatching' AND lease_expires_at <= $1
      RETURNING id, application_session_id`,
    [now],
  );
  for (const batch of stale.rows) {
    await client.query(
      `UPDATE conversation_sessions
          SET pending_operation = false, task_state = 'failed', retired_at = $2::timestamptz,
              delete_after = $2::timestamptz + $3 * interval '1 day'
        WHERE id = $1 AND retired_at IS NULL AND kind = 'proactive'
          AND memory_review_batch_id = $4`,
      [batch.application_session_id, now, SESSION_RETENTION_DAYS, batch.id],
    );
  }
  if (stale.rows.length === 0) return;
  await client.query(
    "DELETE FROM memory_review_batch_sources WHERE batch_id = ANY($1::uuid[])",
    [stale.rows.map((row) => row.id)],
  );
}

export const memoryReviewDispatchRepository = {
  async claimPending(input: {
    leaseMilliseconds: number;
    limit: number;
    now: Date;
  }): Promise<MemoryReviewClaim[]> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await terminalizeStaleInteractiveBatches(client, input.now);
      await terminalizeStaleDispatchingBatches(client, input.now);
      await materializeReadyBatches(client);
      const claimed = await client.query<{
        conversation_id: string; family_id: string; group_id: string;
        group_type: "external" | "family_private"; id: string; lease_token: string;
        message_thread_id: string | null; owner_telegram_user_id: string; owner_user_id: string;
        scope: "family" | "group"; telegram_chat_id: string;
        telegram_chat_type: "group" | "supergroup"; through_sequence: string;
        tool_allowlist: string[];
      }>(
         `WITH candidates AS (
           SELECT batch.id FROM memory_review_batches AS batch
            JOIN memory_review_lanes AS candidate_lane ON candidate_lane.id = batch.lane_id
            WHERE batch.batch_kind = 'background' AND (batch.status = 'pending' OR
              (batch.status = 'leased' AND batch.lease_expires_at <= $1))
              AND batch.predecessor_sequence = candidate_lane.processed_through_sequence
            ORDER BY batch.created_at, batch.id FOR UPDATE OF batch SKIP LOCKED LIMIT $2
         )
         UPDATE memory_review_batches AS batch
            SET status = 'leased', lease_token = gen_random_uuid(),
                lease_expires_at = $1 + $3 * interval '1 millisecond', updated_at = $1
           FROM candidates, memory_review_lanes AS lane,
                application_conversations AS conversation, telegram_groups AS telegram_group,
                family_memberships AS membership, users AS owner
          WHERE batch.id = candidates.id AND lane.id = batch.lane_id
            AND conversation.id = batch.conversation_id
            AND telegram_group.id = conversation.telegram_group_id
            AND membership.family_id = conversation.family_id AND membership.role = 'owner'
            AND owner.id = membership.user_id
         RETURNING batch.id, batch.conversation_id, batch.through_sequence::text,
                   batch.lease_token::text, lane.message_thread_id::text,
                   conversation.family_id, conversation.scope::text,
                   telegram_group.id AS group_id, telegram_group.type::text AS group_type,
                   telegram_group.telegram_chat_id,
                   telegram_group.telegram_chat_type::text AS telegram_chat_type,
                   telegram_group.tool_allowlist,
                   owner.id AS owner_user_id,
                   owner.telegram_user_id AS owner_telegram_user_id`,
        [input.now, input.limit, input.leaseMilliseconds],
      );
      const claims: MemoryReviewClaim[] = [];
      for (const row of claimed.rows) {
        const sources = await client.query<SourceRow>(
          `SELECT message.id, message.sequence_id::text, message.actor_kind, message.actor_id,
                  message.message_thread_id::text, message.sender_username,
                  message.sender_display_name, message.message_kind, message.content_text,
                  message.reply_to_sequence_id::text, message.sent_at
             FROM memory_review_batch_sources AS source
             JOIN telegram_group_messages AS message ON message.id = source.timeline_entry_id
            WHERE source.batch_id = $1 ORDER BY source.timeline_sequence`,
          [row.id],
        );
        if (sources.rows.length !== MEMORY_REVIEW_BATCH_SIZE) throw new AppError(
          "AGENT_MEMORY_REVIEW_SOURCE_SET_INVALID",
          "Пакет проверки памяти не содержит ожидаемые сообщения",
        );
        const entries = sources.rows.map(project);
        claims.push({
          batchId: row.id, conversationId: row.conversation_id, entries,
          familyId: row.family_id, groupId: row.group_id, groupType: row.group_type,
          leaseToken: row.lease_token, messageThreadId: row.message_thread_id,
          ownerTelegramUserId: row.owner_telegram_user_id, ownerUserId: row.owner_user_id,
          prompt: formatMemoryReviewBatchPrompt(entries), scope: row.scope,
          sourceCount: entries.length, sourceEntryIds: sources.rows.map((source) => source.id),
          status: "pending", telegramChatId: row.telegram_chat_id,
          telegramChatType: row.telegram_chat_type,
          toolAllowlist: row.tool_allowlist,
          throughSequence: row.through_sequence,
        });
      }
      await client.query("COMMIT");
      return claims;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async markDispatchStarted(
    batch: MemoryReviewClaim,
    applicationSessionId: string,
  ): Promise<boolean> {
    const result = await database().query(
      `UPDATE memory_review_batches
          SET status = 'dispatching', application_session_id = $3, updated_at = now()
        WHERE id = $1 AND status = 'leased' AND lease_token = $2`,
      [batch.batchId, batch.leaseToken, applicationSessionId],
    );
    return result.rowCount === 1;
  },

  async markRunning(
    batch: MemoryReviewClaim,
    input: { applicationSessionId: string; eveSessionId: string },
  ): Promise<void> {
    const result = await database().query(
      `UPDATE memory_review_batches
          SET status = 'running', eve_session_id = $4,
              started_at = coalesce(started_at, now()), updated_at = now(),
              lease_token = NULL, lease_expires_at = NULL
        WHERE id = $1 AND application_session_id = $3
          AND ((status = 'dispatching' AND lease_token = $2) OR
               (status = 'running' AND eve_session_id = $4))`,
      [batch.batchId, batch.leaseToken, input.applicationSessionId, input.eveSessionId],
    );
    if (result.rowCount !== 1) throw new AppError(
      "AGENT_MEMORY_REVIEW_RUNNING_STATE_INVALID", "Не удалось подтвердить запуск проверки памяти",
    );
  },

  async failClaim(batch: MemoryReviewClaim, diagnosticCode: string): Promise<void> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE memory_review_batches SET status = 'failed', diagnostic_code = $3,
                completed_at = now(), updated_at = now(), lease_token = NULL, lease_expires_at = NULL
          WHERE id = $1 AND status = 'leased' AND lease_token = $2`,
        [batch.batchId, batch.leaseToken, diagnosticCode],
      );
      if (result.rowCount !== 1) throw new AppError(
        "AGENT_MEMORY_REVIEW_FAILURE_STATE_INVALID", "Не удалось сохранить ошибку проверки памяти",
      );
      await client.query("DELETE FROM memory_review_batch_sources WHERE batch_id = $1", [batch.batchId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async markAmbiguous(
    batch: MemoryReviewClaim,
    diagnosticCode: string,
    applicationSessionId: string,
  ): Promise<void> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE memory_review_batches SET status = 'ambiguous', diagnostic_code = $3,
                 application_session_id = coalesce(application_session_id, $4),
                 completed_at = now(), updated_at = now(), lease_token = NULL, lease_expires_at = NULL
           WHERE id = $1 AND status IN ('leased', 'dispatching') AND lease_token = $2
             AND (application_session_id IS NULL OR application_session_id = $4)`,
        [batch.batchId, batch.leaseToken, diagnosticCode, applicationSessionId],
      );
      if (result.rowCount !== 1) throw new AppError(
        "AGENT_MEMORY_REVIEW_AMBIGUOUS_STATE_INVALID",
        "Не удалось сохранить неоднозначный результат проверки памяти",
      );
      // Handoff ambiguity is terminal for the one-shot application session as well as its batch.
      await client.query(
        `UPDATE conversation_sessions
            SET pending_operation = false, task_state = 'failed', retired_at = now(),
                delete_after = now() + $2 * interval '1 day'
          WHERE id = $1 AND retired_at IS NULL AND kind = 'proactive'
            AND memory_review_batch_id = $3`,
        [applicationSessionId, SESSION_RETENTION_DAYS, batch.batchId],
      );
      await client.query("DELETE FROM memory_review_batch_sources WHERE batch_id = $1", [batch.batchId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async markSessionAmbiguous(input: {
    batchId: string;
    diagnosticCode: string;
    eveSessionId: string;
  }): Promise<void> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      // Lock the application root before the batch so concurrent Eve binding cannot change owner.
      const session = await client.query<{ id: string }>(
        `SELECT app_session.id
           FROM conversation_sessions AS app_session
          WHERE app_session.id = (
            SELECT application_session_id FROM memory_review_batches WHERE id = $1
          )
            AND (app_session.eve_session_id IS NULL OR app_session.eve_session_id = $2)
          FOR UPDATE`,
        [input.batchId, input.eveSessionId],
      );
      if (!session.rows[0]) {
        await client.query("ROLLBACK");
        return;
      }
      const batch = await client.query<{ application_session_id: string }>(
        `UPDATE memory_review_batches AS batch
            SET status = 'ambiguous', eve_session_id = coalesce(batch.eve_session_id, $2),
                diagnostic_code = $3, completed_at = now(), updated_at = now(),
                lease_token = NULL, lease_expires_at = NULL
          WHERE batch.id = $1 AND batch.batch_kind = 'background'
            AND batch.application_session_id = $4
            AND batch.status IN ('dispatching', 'running')
            AND (batch.eve_session_id IS NULL OR batch.eve_session_id = $2)
          RETURNING batch.application_session_id`,
        [input.batchId, input.eveSessionId, input.diagnosticCode, session.rows[0].id],
      );
      const applicationSessionId = batch.rows[0]?.application_session_id;
      if (!applicationSessionId) {
        await client.query("ROLLBACK");
        return;
      }
      await client.query(
        `UPDATE conversation_sessions
            SET pending_operation = false, task_state = 'failed', eve_session_id = $2,
                retired_at = now(), delete_after = now() + $3 * interval '1 day'
          WHERE id = $1 AND retired_at IS NULL AND kind = 'proactive'
            AND memory_review_batch_id = $4`,
        [applicationSessionId, input.eveSessionId, SESSION_RETENTION_DAYS, input.batchId],
      );
      await client.query("DELETE FROM memory_review_batch_sources WHERE batch_id = $1", [input.batchId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async markInteractiveSessionAmbiguous(input: {
    continuationToken: string;
    diagnosticCode: string;
    eveSessionId: string;
  }): Promise<"recorded" | "stale" | null> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      // Serialize exact-root classification with every bind/rotation of the canonical session.
      const session = await client.query<{
        eve_session_id: string | null;
        id: string;
        retired_at: Date | null;
      }>(
        `SELECT id, eve_session_id, retired_at FROM conversation_sessions
          WHERE continuation_token = $1 FOR UPDATE`,
        [input.continuationToken],
      );
      const current = session.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return null;
      }
      if (current.eve_session_id !== input.eveSessionId) {
        await client.query("ROLLBACK");
        return "stale";
      }
      const result = await client.query<{ batch_id: string }>(
        `UPDATE memory_review_batches AS batch
             SET status = 'ambiguous', diagnostic_code = $2, completed_at = now(), updated_at = now()
           WHERE batch.application_session_id = $3 AND batch.eve_session_id = $1
             AND batch.batch_kind = 'interactive' AND batch.status = 'running'
           RETURNING batch.id AS batch_id`,
        [input.eveSessionId, input.diagnosticCode, current.id],
      );
      if (result.rowCount === 0) {
        const review = await client.query(
          `SELECT 1 FROM memory_review_batches
            WHERE application_session_id = $1 AND batch_kind = 'interactive'`,
          [current.id],
        );
        if (!review.rows[0]) {
          await client.query("ROLLBACK");
          return null;
        }
      }
      await client.query(
        `UPDATE conversation_sessions
            SET pending_operation = false, rotation_requested_at = now()
          WHERE id = $1 AND eve_session_id = $2 AND retired_at IS NULL`,
        [current.id, input.eveSessionId],
      );
      if (result.rows[0]) {
        await client.query(
          "DELETE FROM memory_review_batch_sources WHERE batch_id = $1",
          [result.rows[0].batch_id],
        );
      }
      await client.query("COMMIT");
      return "recorded";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
