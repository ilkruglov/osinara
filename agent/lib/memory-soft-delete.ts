/**
 * Soft deletion of memory records, inside the caller's transaction.
 *
 * Export:
 * - `softDeleteMemory`: hides a record.
 *
 * Key constructs:
 * - Deletion is soft: an agent's mistake must not take a fact away for good. The `memory_items`
 *   view hides the row from every read and from vector search. The claim becomes retracted, so the
 *   existing triggers drop its thread and confirmed-outcome projections exactly as the physical
 *   cascade did. The successor references are cleared: `memory_items_lifecycle_shape` refuses a
 *   retracted row with them, and deleting a superseded record used to fail.
 * - Person cards wrote the repeats (`duplicate`) and no longer clean memory; migration 153 returned
 *   or deleted every one of theirs (owner, 23 November 2026). Deleting a record takes nothing else
 *   along. Repeats of the consolidation before v0.12.0 would stay (none on production): purging
 *   their kept record makes them active.
 * - Indexing jobs are derived: kept for a hidden row they only keep the worker busy; a restore
 *   queues them again.
 */
import type { PoolClient } from "pg";

export async function softDeleteMemory(client: PoolClient, memoryItemId: string): Promise<void> {
  await client.query(
    `UPDATE memory_items_all
        SET deleted_at = now(), claim_status = 'retracted', superseded_by = NULL, duplicate_of = NULL
      WHERE id = $1 AND deleted_at IS NULL`,
    [memoryItemId],
  );
  await client.query("DELETE FROM memory_embedding_jobs WHERE memory_item_id = $1", [memoryItemId]);
}
