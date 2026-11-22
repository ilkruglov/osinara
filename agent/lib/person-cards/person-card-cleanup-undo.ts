/**
 * Undo of the person card cleanup.
 *
 * Export:
 * - `undoPersonCardCleanups`: returns to active every record the cards marked as a repeat or as
 *   refuted (all of them, or one build's), except a record people changed or deleted since.
 *
 * Key constructs:
 * - A record is restored only while it is exactly as the cleanup left it: same `updated_at`, same
 *   status, not deleted. Otherwise the cleanup row is closed as `changed_since` and the record is
 *   left to the people who changed it.
 * - A repeat of a record that is deleted since stays hidden: it is the fact the person deleted. So
 *   does a record whose slot got another version (or whose text was written again about the same
 *   person) while it was hidden: memory writes saw its slot empty, and two active versions are
 *   worse than the cleanup. Records that stood together do not count, whichever was cleaned
 *   first: one in the other's `slot_mate_ids` (what stood beside a record when it was cleaned,
 *   its kept record above all).
 * - One record per transaction, newest first: of two versions of one slot hidden by two builds the
 *   newer comes back and the older stays hidden. Each transaction takes the locks of the slot and
 *   of the same text first, as memory writes do (a write that found the slot empty or the text
 *   missing commits before the check, or waits), then the record, then its journal row, as the
 *   purge of the kept record does (trigger, then foreign key); a deadlock retries it once. A
 *   delete of the kept record running at the same time skips a repeat this undo restored. A
 *   failure stops the command with the records before it restored; running it again continues.
 * - Each restore writes an audit event. The record is back in search at once, and in the profile
 *   block or beside its card at once: no card counts it as read any more, whatever the area (a
 *   family record also sits in the member's personal card). A build already running read the
 *   record while it was hidden, so it never counts it as read either. Restored records are never
 *   cleaned again.
 * - `--build` with an id that does not exist is an error, not "nothing to undo".
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { lockExactMemoryDuplicate } from "../memory-exact-reinforcement.js";
import { lockMemorySlot, type MemorySlotIdentity } from "../memory-slot-supersede.js";
import { retryOnTransactionConflict } from "../transaction-conflict-retry.js";
import { slotMateSql } from "./person-card-links.js";
import { personCardTransaction } from "./person-card-transaction.js";

export interface UndoPersonCardCleanupsResult {
  changedSince: number;
  restored: number;
}

export async function undoPersonCardCleanups(input: {
  buildId: string | null;
}): Promise<UndoPersonCardCleanupsResult> {
  if (input.buildId !== null) {
    const build = await database().query("SELECT 1 FROM person_card_builds WHERE id = $1", [
      input.buildId,
    ]);
    if (build.rowCount !== 1) {
      throw new AppError("AGENT_PERSON_CARD_BUILD_NOT_FOUND", "Сборка карточки не найдена");
    }
  }
  const open = await database().query<{ id: string }>(
    `SELECT cleanup.id FROM person_card_cleanups AS cleanup
     JOIN memory_items_all AS item ON item.id = cleanup.memory_item_id
     WHERE cleanup.undone_at IS NULL AND ($1::uuid IS NULL OR cleanup.build_id = $1)
     ORDER BY item.created_at DESC, item.id DESC`,
    [input.buildId],
  );
  const result: UndoPersonCardCleanupsResult = { changedSince: 0, restored: 0 };
  for (const { id } of open.rows) {
    const outcome = await retryOnTransactionConflict(() =>
      personCardTransaction((client) => undoOne(client, id)),
    );
    if (outcome === "restored") result.restored += 1;
    else if (outcome === "changed_since") result.changedSince += 1;
  }
  return result;
}

type CleanedRecord = Omit<MemorySlotIdentity, "attribute"> & {
  attribute: string | null;
  contentNormalized: string | null;
  familyId: string;
  id: string;
};

/** "gone": another undo closed the row meanwhile, or the record was purged with it. */
async function undoOne(
  client: PoolClient,
  cleanupId: string,
): Promise<"changed_since" | "gone" | "restored"> {
  const cleaned = await client.query<CleanedRecord>(
    `SELECT item.id, item.family_id AS "familyId", item.scope,
            item.scope_partition_key AS "scopePartitionKey", item.attribute, item.kind,
            item.subject_label AS "subjectLabel",
            item.subject_participant_id AS "subjectParticipantId",
            item.subject_user_id AS "subjectUserId", item.memory_project_id AS "memoryProjectId",
            item.content_normalized AS "contentNormalized"
     FROM person_card_cleanups AS cleanup
     JOIN memory_items_all AS item ON item.id = cleanup.memory_item_id
     WHERE cleanup.id = $1`,
    [cleanupId],
  );
  const record = cleaned.rows[0];
  if (record === undefined) return "gone";
  // In memory writes' order: the slot, then the same text, then rows.
  if (record.attribute !== null) {
    await lockMemorySlot(client, record.familyId, { ...record, attribute: record.attribute });
  }
  if (record.contentNormalized !== null) {
    await lockExactMemoryDuplicate(client, {
      ...record,
      contentNormalized: record.contentNormalized,
    });
  }
  await client.query("SELECT 1 FROM memory_items_all WHERE id = $1 FOR UPDATE", [record.id]);
  const open = await client.query(
    "SELECT 1 FROM person_card_cleanups WHERE id = $1 AND undone_at IS NULL FOR UPDATE",
    [cleanupId],
  );
  if (open.rowCount !== 1) return "gone";
  const restored = await client.query(
    `WITH restored AS (
       UPDATE memory_items_all AS item SET claim_status = 'active', duplicate_of = NULL,
         superseded_by = NULL, updated_at = now()
       FROM person_card_cleanups AS cleanup
       WHERE cleanup.id = $1 AND item.id = cleanup.memory_item_id
         AND item.deleted_at IS NULL AND item.updated_at = cleanup.cleaned_updated_at
         AND item.claim_status = CASE cleanup.reason WHEN 'duplicate' THEN 'duplicate'
                                                     ELSE 'superseded' END::memory_claim_status
         AND (cleanup.reason <> 'duplicate' OR EXISTS (
           SELECT 1 FROM memory_items AS kept WHERE kept.id = cleanup.kept_memory_item_id
         ))
         AND NOT EXISTS (
           SELECT 1 FROM memory_items AS other
           WHERE ${slotMateSql("other", "item")} AND other.claim_status = 'active'
             AND other.id <> ALL(cleanup.slot_mate_ids)
             AND NOT EXISTS (SELECT 1 FROM person_card_cleanups AS theirs
                             WHERE theirs.memory_item_id = other.id
                               AND item.id = ANY(theirs.slot_mate_ids))
         )
       RETURNING cleanup.family_id, item.id AS memory_item_id, cleanup.reason
     )
     INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
     SELECT family_id, NULL, 'memory.person_card_cleanup_undone', memory_item_id,
            jsonb_build_object('cleanupId', $1::text, 'reason', reason)
     FROM restored`,
    [cleanupId],
  );
  const outcome = restored.rowCount === 1 ? "restored" : "changed_since";
  await client.query(
    "UPDATE person_card_cleanups SET undone_at = now(), undo_outcome = $2 WHERE id = $1",
    [cleanupId, outcome],
  );
  // No card counts the restored record as read any more: the profile block shows it at once
  // (records with subject ids), cards list it as not yet in the card (label-only ones), it counts
  // as new for the next build, and a restored record is never cleaned again.
  if (outcome === "restored") {
    await client.query("DELETE FROM person_card_reads WHERE memory_item_id = $1", [record.id]);
  }
  return outcome;
}
