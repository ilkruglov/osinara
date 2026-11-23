/**
 * Where silent review of a group starts when the owner turns it back on.
 *
 * Exports:
 * - `restartMemoryReviewAtJournalEnd`: moves every topic's lane cursor, and the floor of its
 *   earlier context, to its last journal entry, creating the lanes not yet there, inside the
 *   caller's transaction and the claim pass's lock (`MEMORY_REVIEW_CLAIM_LOCK`).
 * - `discardUnreachableReviewBatches`: drops background batches behind their lane's cursor that
 *   never reached Eve, retiring the session a worker prepared for one, and releases the sources of
 *   failed or ambiguous ones there; every claim pass runs it and logs the count once it commits (a
 *   pass that failed later rolled the drop back under a log saying it happened).
 *
 * Key construct:
 * - The journal keeps every entry since 22 November 2026, so the period review was off would be
 *   reviewed, and paid for, in full; the owner chose «С момента включения». The cursor only moves
 *   forward, and a batch is claimed and dispatched only at the cursor, so a batch left behind would
 *   wait forever (final review, 22 November 2026). The next claim pass drops a pending one; a
 *   leased one is refused at dispatch and goes when its lease ends, since its worker may still
 *   hold it.
 */
import type { PoolClient } from "pg";

import { retireAbandonedReviewSession } from "./memory-review-terminal-repository.js";

/** Returns how many batches it dropped: the caller logs them once its transaction commits. */
export async function discardUnreachableReviewBatches(
  client: PoolClient,
  now: Date,
): Promise<number> {
  // A failed or ambiguous batch behind the cursor stays as the record of what happened, but no
  // recovery reaches it there (recovery takes the batch at the cursor), so its sources go now.
  await client.query(
    `DELETE FROM memory_review_batch_sources AS source
      USING memory_review_batches AS batch, memory_review_lanes AS lane
      WHERE source.batch_id = batch.id AND lane.id = batch.lane_id
        AND batch.status IN ('failed', 'ambiguous')
        AND batch.predecessor_sequence < lane.processed_through_sequence`,
  );
  const unreachable = await client.query<{ id: string; session_id: string | null }>(
    `SELECT batch.id, session.id AS session_id
       FROM memory_review_batches AS batch
       JOIN memory_review_lanes AS lane ON lane.id = batch.lane_id
       -- A worker that died between preparing its session and dispatching leaves it unstarted.
       LEFT JOIN conversation_sessions AS session
         ON session.memory_review_batch_id = batch.id AND session.eve_session_id IS NULL
      WHERE batch.batch_kind = 'background'
        AND batch.predecessor_sequence < lane.processed_through_sequence
        AND (batch.status = 'pending' OR (batch.status = 'leased' AND batch.lease_expires_at <= $1))
      FOR UPDATE OF batch SKIP LOCKED`,
    [now],
  );
  if (unreachable.rowCount === 0) return 0;
  for (const row of unreachable.rows) {
    if (row.session_id !== null) await retireAbandonedReviewSession(client, row.session_id, now);
  }
  // The sources go with the batch (ON DELETE CASCADE); they lie behind the cursor for good.
  await client.query("DELETE FROM memory_review_batches WHERE id = ANY($1::uuid[])", [
    unreachable.rows.map((row) => row.id),
  ]);
  return unreachable.rows.length;
}

/**
 * The claim pass's lock: the one other writer that holds several lanes at once. Restarting a
 * group's lanes inside it, the two never wait on each other's lanes in opposite orders (final
 * review, 22 November 2026: two forum topics deadlocked the owner's policy update).
 */
export const MEMORY_REVIEW_CLAIM_LOCK = "osinara.memory_review_claim";

export async function restartMemoryReviewAtJournalEnd(
  client: PoolClient,
  groupId: string,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [MEMORY_REVIEW_CLAIM_LOCK]);
  await client.query(
    `INSERT INTO memory_review_lanes
       (conversation_id, message_thread_id, processed_through_sequence, context_floor_sequence)
     SELECT conversation_id, message_thread_id, max(sequence_id), max(sequence_id)
       FROM telegram_group_messages
      WHERE group_id = $1 AND conversation_id IS NOT NULL
      GROUP BY conversation_id, message_thread_id
     ON CONFLICT (conversation_id, message_thread_id) DO UPDATE
        SET processed_through_sequence = GREATEST(
              memory_review_lanes.processed_through_sequence,
              EXCLUDED.processed_through_sequence),
            context_floor_sequence = GREATEST(
              memory_review_lanes.context_floor_sequence,
              EXCLUDED.context_floor_sequence),
            updated_at = now()`,
    [groupId],
  );
}
