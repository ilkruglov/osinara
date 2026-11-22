/**
 * Publishing a built card, or recording why a build failed.
 *
 * Exports:
 * - `publishPersonCard`: one transaction under the build's lease: cleanup, new card version,
 *   cited sources, build outcome.
 * - `failPersonCardBuild`: ends a build with a stable error code while it still holds the lease;
 *   false when it no longer did.
 * - `retirePersonCard`: removes the card of a person with nothing left to build from.
 *
 * Key constructs:
 * - A build that lost its lease publishes nothing: the lease token is checked under the build row's
 *   lock, so a reclaimed build and its replacement never both publish.
 * - The cleanup locks every record and its kept record and touches it only if it is still the
 *   version the model read, still active, of the card's own area and partition, not confirmed by a
 *   person, not an episode, not restored by an undo, no thread or confirmed outcome stands on it,
 *   and, when refuted, the kept record is newer. Anything else is skipped and counted, never
 *   forced. A build whose lease expired publishes nothing even before the lease is reclaimed.
 * - A repeat becomes `duplicate` of the kept record, a refuted record `superseded` by it; both
 *   leave search and the profile block. The cleanup row keeps the record's new `updated_at`, so
 *   undo can tell a record people changed since.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { sliceText } from "../display-text.js";
import { retryOnTransactionConflict } from "../transaction-conflict-retry.js";
import { LEASED_BUILD_SQL } from "./person-card-dispatch-repository.js";
import { cleanupUntouchedSql, slotMateSql } from "./person-card-links.js";
import { personCardTransaction } from "./person-card-transaction.js";
import type { PersonCardKey } from "./person-card-links.js";
import type { PersonCardCleanup, PersonCardSections } from "./person-card-parse.js";
import type { PersonCardSource } from "./person-card-sources-repository.js";

export interface PublishPersonCardInput {
  buildId: string;
  characters: number;
  cited: readonly PersonCardSource[];
  cleanup: readonly PersonCardCleanup[];
  cleanupEnabled: boolean;
  inputRecords: number;
  key: PersonCardKey;
  leaseToken: string;
  /** Every record the build read, cited or not: what the card knows. */
  readIds: readonly string[];
  sections: PersonCardSections;
  sourcesAsOf: Date;
  subjectLabel: string;
}

export interface PublishPersonCardResult {
  cardVersion: number;
  cleaned: number;
  cleanupSkipped: number;
}

async function lockLeasedBuild(client: PoolClient, buildId: string, leaseToken: string) {
  const build = await client.query(
    `SELECT 1 FROM person_card_builds
     WHERE ${LEASED_BUILD_SQL} FOR UPDATE`,
    [buildId, leaseToken],
  );
  if (build.rowCount !== 1) throw leaseLost();
}

function leaseLost(): AppError {
  return new AppError("AGENT_PERSON_CARD_LEASE_LOST", "Сборка карточки потеряла аренду");
}

async function cleanOne(
  client: PoolClient,
  input: PublishPersonCardInput,
  entry: PersonCardCleanup,
): Promise<boolean> {
  // Both rows locked first: a concurrent delete of the kept record waits, and nothing below reads
  // a snapshot older than the locks.
  const locked = await client.query<{ id: string }>(
    `SELECT item.id FROM memory_items AS item
     JOIN memory_items AS kept ON kept.id = $5 AND kept.id <> item.id
       AND kept.family_id = item.family_id AND kept.scope = item.scope
       AND kept.scope_partition_key = item.scope_partition_key AND kept.claim_status = 'active'
     WHERE item.id = $1 AND item.family_id = $2 AND item.claim_status = 'active'
       AND item.updated_at = $3::timestamptz AND item.confirmation <> 'user_confirmed'
       AND item.kind <> 'episode' AND item.scope = $4::memory_scope
       AND item.scope_partition_key = $6
       AND ($7::text <> 'refuted' OR kept.created_at > item.created_at)
     FOR NO KEY UPDATE OF item FOR KEY SHARE OF kept`,
    [
      entry.memoryItemId,
      input.key.familyId,
      entry.readVersion,
      input.key.area,
      entry.keptMemoryItemId,
      input.key.areaKey,
      entry.reason,
    ],
  );
  if (locked.rowCount !== 1) return false;
  // Read after the locks: a thread or outcome attached meanwhile protects the record; marking it
  // would remove it from the thread and withdraw the outcome beyond undo. A record an undo
  // restored stays: that was a person's correction.
  const record = await client.query(
    `SELECT 1 FROM memory_items_all AS item WHERE item.id = $1 AND ${cleanupUntouchedSql("item")}`,
    [entry.memoryItemId],
  );
  if (record.rowCount !== 1) return false;
  // A row still open for an active record is stale: its kept record was purged and a trigger
  // returned this one to active.
  await client.query(
    `UPDATE person_card_cleanups SET undone_at = now(), undo_outcome = 'changed_since'
     WHERE memory_item_id = $1 AND undone_at IS NULL`,
    [entry.memoryItemId],
  );
  await client.query(
    entry.reason === "duplicate"
      ? `UPDATE memory_items SET claim_status = 'duplicate', duplicate_of = $2, superseded_by = NULL,
           updated_at = now() WHERE id = $1`
      : `UPDATE memory_items SET claim_status = 'superseded', superseded_by = $2, duplicate_of = NULL,
           updated_at = now() WHERE id = $1`,
    [entry.memoryItemId, entry.keptMemoryItemId],
  );
  // The record's new version is copied in SQL: a JS Date would drop its microseconds and undo
  // would take every cleaned record for one people changed since.
  await client.query(
    `INSERT INTO person_card_cleanups
       (build_id, family_id, memory_item_id, kept_memory_item_id, reason, explanation,
        cleaned_updated_at)
     SELECT $1, $2, item.id, $4, $5, $6, item.updated_at
     FROM memory_items_all AS item WHERE item.id = $3`,
    [
      input.buildId,
      input.key.familyId,
      entry.memoryItemId,
      entry.keptMemoryItemId,
      entry.reason,
      entry.explanation,
    ],
  );
  await client.query(
    `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
     VALUES ($1, NULL, 'memory.person_card_cleanup', $2,
             jsonb_build_object('reason', $3::text, 'keptBy', $4::text, 'buildId', $5::text))`,
    [input.key.familyId, entry.memoryItemId, entry.reason, entry.keptMemoryItemId, input.buildId],
  );
  return true;
}

/**
 * What stands beside each record this build cleaned, in its slot or with its text, active or
 * cleaned by this build too: none of it keeps the record hidden at undo. One statement for the
 * whole build: a query per record read the family's every group record each time.
 */
async function recordSlotMates(client: PoolClient, buildId: string): Promise<void> {
  await client.query(
    `UPDATE person_card_cleanups AS cleanup SET slot_mate_ids = mates.ids
     FROM (
       SELECT this.id, array_agg(other.id) AS ids
       FROM person_card_cleanups AS this
       JOIN memory_items_all AS item ON item.id = this.memory_item_id
       JOIN memory_items AS other ON ${slotMateSql("other", "item")}
       WHERE this.build_id = $1
         AND (other.claim_status = 'active' OR other.id IN (
           SELECT same.memory_item_id FROM person_card_cleanups AS same WHERE same.build_id = $1))
       GROUP BY this.id
     ) AS mates
     WHERE cleanup.id = mates.id`,
    [buildId],
  );
}

/**
 * One retry on a deadlock or serialization failure: a person deleting a record locks it before its
 * repeats, against the publish's order, and PostgreSQL then aborts one side, which retries (the
 * delete does too). The model was already paid for; the retry starts over from the locks.
 */
export async function publishPersonCard(
  input: PublishPersonCardInput,
): Promise<PublishPersonCardResult> {
  return retryOnTransactionConflict(() => publishOnce(input));
}

async function publishOnce(input: PublishPersonCardInput): Promise<PublishPersonCardResult> {
  return personCardTransaction(async (client) => {
    await lockLeasedBuild(client, input.buildId, input.leaseToken);
    let cleaned = 0;
    // Every record this publish touches, read and cited ones included (their foreign keys lock
    // them too), first and in the order memory reinforcement locks them: no cycle with a turn.
    // NO KEY UPDATE, not UPDATE: the foreign keys a turn's profile block inserts take KEY SHARE on
    // the same records in their own order, and only the full UPDATE lock conflicts with that.
    await client.query(
      `SELECT 1 FROM memory_items_all WHERE id = ANY($1::uuid[])
       ORDER BY created_at, id FOR NO KEY UPDATE`,
      [
        [
          ...new Set([
            ...input.readIds,
            ...input.cited.map((source) => source.id),
            ...(input.cleanupEnabled
              ? input.cleanup.flatMap((entry) => [entry.memoryItemId, entry.keptMemoryItemId])
              : []),
          ]),
        ],
      ],
    );
    const skipped = new Set<string>();
    if (input.cleanupEnabled) {
      for (const entry of input.cleanup) {
        if (await cleanOne(client, input, entry)) cleaned += 1;
        else skipped.add(entry.memoryItemId);
      }
      if (cleaned > 0) await recordSlotMates(client, input.buildId);
    }
    const card = await client.query<{ id: string; version: number }>(
      `INSERT INTO person_cards
         (family_id, area, area_key, subject_telegram_user_id, subject_label, version, sections,
          rendered_characters, source_count, sources_as_of)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9)
       ON CONFLICT (family_id, area, area_key, subject_telegram_user_id) DO UPDATE SET
         subject_label = EXCLUDED.subject_label, version = person_cards.version + 1,
         sections = EXCLUDED.sections, rendered_characters = EXCLUDED.rendered_characters,
         source_count = EXCLUDED.source_count, sources_as_of = EXCLUDED.sources_as_of,
         built_at = now()
       RETURNING id, version`,
      [
        input.key.familyId,
        input.key.area,
        input.key.areaKey,
        input.key.subjectTelegramUserId,
        sliceText(input.subjectLabel, 200),
        JSON.stringify(input.sections),
        input.characters,
        input.cited.length,
        input.sourcesAsOf,
      ],
    );
    const { id: cardId, version } = card.rows[0]!;
    await client.query("DELETE FROM person_card_sources WHERE card_id = $1", [cardId]);
    await client.query("DELETE FROM person_card_reads WHERE card_id = $1", [cardId]);
    // A record whose cleanup was skipped is not read: the parser already took the card's items off
    // it (to its kept record, or dropped as refuted) on grounds that changed since, so the profile
    // block shows it and the next build reads it again. With the cleanup switched off the grounds
    // stand (the kept record is in the card): it stays read, or it would count as new every build.
    await client.query(
      `INSERT INTO person_card_reads (card_id, memory_item_id)
       SELECT $1, item.id FROM memory_items_all AS item WHERE item.id = ANY($2::uuid[])`,
      [cardId, input.readIds.filter((id) => !skipped.has(id))],
    );
    // A record purged since it was read is skipped; the card then counts as changed and is rebuilt.
    await client.query(
      `INSERT INTO person_card_sources (card_id, memory_item_id, source_updated_at, link)
       SELECT $1, item.id, cited.updated_at, cited.link
       FROM unnest($2::uuid[], $3::timestamptz[], $4::text[]) AS cited(id, updated_at, link)
       JOIN memory_items_all AS item ON item.id = cited.id`,
      [
        cardId,
        input.cited.map((source) => source.id),
        input.cited.map((source) => source.version),
        input.cited.map((source) => source.link),
      ],
    );
    // The lease is checked again at the end: it may have run out while the locks were awaited.
    const finished = await client.query(
      `UPDATE person_card_builds SET status = 'succeeded', finished_at = now(), lease_token = NULL,
         lease_expires_at = NULL, card_version = $3, input_records = $4, cited_records = $5,
         cleaned_records = $6, error_code = NULL
       WHERE ${LEASED_BUILD_SQL}`,
      [input.buildId, input.leaseToken, version, input.inputRecords, input.cited.length, cleaned],
    );
    if (finished.rowCount !== 1) throw leaseLost();
    return { cardVersion: version, cleaned, cleanupSkipped: input.cleanup.length - cleaned };
  });
}

/**
 * A person with nothing left to build from (their records deleted, their label gone): the card
 * goes and the build ends as done, not as a failure that would repeat every day.
 */
export async function retirePersonCard(input: {
  buildId: string;
  key: PersonCardKey;
  leaseToken: string;
}): Promise<void> {
  await personCardTransaction(async (client) => {
    await lockLeasedBuild(client, input.buildId, input.leaseToken);
    await client.query(
      `DELETE FROM person_cards WHERE family_id = $1 AND area = $2 AND area_key = $3
         AND subject_telegram_user_id = $4`,
      [input.key.familyId, input.key.area, input.key.areaKey, input.key.subjectTelegramUserId],
    );
    const finished = await client.query(
      `UPDATE person_card_builds SET status = 'succeeded', finished_at = now(), lease_token = NULL,
         lease_expires_at = NULL, input_records = 0, cited_records = 0, error_code = NULL
       WHERE ${LEASED_BUILD_SQL}`,
      [input.buildId, input.leaseToken],
    );
    if (finished.rowCount !== 1) throw leaseLost();
  });
}

export async function failPersonCardBuild(input: {
  buildId: string;
  errorCode: string;
  inputRecords: number | null;
  leaseToken: string;
  /** Any attempt of the build may have cost a model call (`possibly_paid`, the weekly cap). */
  possiblyPaid: boolean;
}): Promise<boolean> {
  const result = await database().query(
    `UPDATE person_card_builds SET status = 'failed', finished_at = now(), lease_token = NULL,
       lease_expires_at = NULL, error_code = $3, input_records = $4,
       possibly_paid = possibly_paid OR $5
     WHERE ${LEASED_BUILD_SQL}`,
    [input.buildId, input.leaseToken, input.errorCode, input.inputRecords, input.possiblyPaid],
  );
  return result.rowCount === 1;
}
