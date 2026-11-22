/**
 * Soft deletion of memory records, inside the caller's transaction.
 *
 * Export:
 * - `softDeleteMemoryWithRepeats`: hides a record and every record marked as a repeat of it;
 *   returns the ids of the repeats.
 *
 * Key constructs:
 * - Deletion is soft: an agent's mistake must not take a fact away for good. The `memory_items`
 *   view hides the row from every read and from vector search. The claim becomes retracted, so the
 *   existing triggers drop its thread and confirmed-outcome projections exactly as the physical
 *   cascade did. The successor references are cleared: `memory_items_lifecycle_shape` refuses a
 *   retracted row with them, and deleting a superseded record used to fail.
 * - A repeat (`duplicate`, written by the person card cleanup) is the same fact: forgetting the
 *   record forgets it too. Otherwise purging the record after the recovery window returned the
 *   repeat to active through `clear_memory_lifecycle_references` (review, 21 November 2026). A
 *   whole chain goes (A a repeat of B, B of the deleted C), though the cleanup no longer builds
 *   chains: an end left behind would come back the same way.
 * - Indexing jobs are derived: kept for a hidden row they only keep the worker busy; a restore
 *   queues them again.
 */
import type { PoolClient } from "pg";

import type { MemoryAuthorization } from "./memory-context.js";

const SOFT_DELETE_SQL = `UPDATE memory_items_all
    SET deleted_at = now(), claim_status = 'retracted', superseded_by = NULL, duplicate_of = NULL`;

export async function softDeleteMemoryWithRepeats(
  client: PoolClient,
  auth: MemoryAuthorization,
  memoryItemId: string,
): Promise<string[]> {
  // Repeats first: they still point at the record by `duplicate_of`.
  const repeats = await client.query<{ id: string }>(
    `WITH RECURSIVE chain AS (
       SELECT id FROM memory_items_all
       WHERE duplicate_of = $1 AND claim_status = 'duplicate' AND deleted_at IS NULL
       UNION
       SELECT repeat.id FROM memory_items_all AS repeat JOIN chain ON repeat.duplicate_of = chain.id
       WHERE repeat.claim_status = 'duplicate' AND repeat.deleted_at IS NULL
     ), repeats AS (
       ${SOFT_DELETE_SQL}
       -- Rechecked on the row after waiting for its lock: an undo that restored it meanwhile wins.
       WHERE id IN (SELECT id FROM chain) AND claim_status = 'duplicate' AND deleted_at IS NULL
       RETURNING id, kind::text, scope::text
     )
     INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
     SELECT $2, $3, 'memory.deleted', repeats.id,
            jsonb_build_object('scope', repeats.scope, 'kind', repeats.kind,
                               'reason', 'repeat_of_deleted', 'repeatOf', $1::text)
     FROM repeats
     RETURNING subject_id AS id`,
    [memoryItemId, auth.familyId, auth.userId],
  );
  await client.query(`${SOFT_DELETE_SQL} WHERE id = $1 AND deleted_at IS NULL`, [memoryItemId]);
  const ids = [memoryItemId, ...repeats.rows.map((row) => row.id)];
  await client.query("DELETE FROM memory_embedding_jobs WHERE memory_item_id = ANY($1::uuid[])", [
    ids,
  ]);
  return ids.slice(1);
}
