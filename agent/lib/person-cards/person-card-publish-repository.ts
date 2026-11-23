/**
 * Publishing a built card, or recording why a build failed.
 *
 * Exports:
 * - `publishPersonCard`: one transaction under the build's lease: new card version, what it read,
 *   cited sources, build outcome.
 * - `failPersonCardBuild`: ends a build with a stable error code while it still holds the lease;
 *   false when it no longer did.
 * - `retirePersonCard`: removes the card of a person with nothing left to build from.
 *
 * Key constructs:
 * - A build that lost its lease publishes nothing: the lease token is checked under the build row's
 *   lock, so a reclaimed build and its replacement never both publish.
 *   A build whose lease expired publishes nothing even before the lease is reclaimed.
 * - The publish locks the records it read in creation order; resolving a memory conflict locks its
 *   two records in its own order, and the two can deadlock. PostgreSQL aborts one side; an aborted
 *   publish runs again once (review of the fixes, 23 November 2026: a lost publish failed a paid
 *   build).
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { sliceText } from "../display-text.js";
import { retryOnTransactionConflict } from "../transaction-conflict-retry.js";
import { LEASED_BUILD_SQL } from "./person-card-dispatch-repository.js";
import { personCardTransaction } from "./person-card-transaction.js";
import type { PersonCardKey } from "./person-card-links.js";
import type { PersonCardSections } from "./person-card-parse.js";
import type { PersonCardSource } from "./person-card-sources-repository.js";

export interface PublishPersonCardInput {
  buildId: string;
  characters: number;
  cited: readonly PersonCardSource[];
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

export async function publishPersonCard(
  input: PublishPersonCardInput,
): Promise<PublishPersonCardResult> {
  return retryOnTransactionConflict(() => publishOnce(input));
}

async function publishOnce(input: PublishPersonCardInput): Promise<PublishPersonCardResult> {
  return personCardTransaction(async (client) => {
    await lockLeasedBuild(client, input.buildId, input.leaseToken);
    // Every record this publish references, read and cited ones (their foreign keys lock them
    // too), first and in the order memory reinforcement locks them: no cycle with a turn.
    // NO KEY UPDATE, not UPDATE: the foreign keys a turn's profile block inserts take KEY SHARE on
    // the same records in their own order, and only the full UPDATE lock conflicts with that.
    await client.query(
      `SELECT 1 FROM memory_items_all WHERE id = ANY($1::uuid[])
       ORDER BY created_at, id FOR NO KEY UPDATE`,
      [[...new Set([...input.readIds, ...input.cited.map((source) => source.id)])]],
    );
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
    await client.query(
      `INSERT INTO person_card_reads (card_id, memory_item_id)
       SELECT $1, item.id FROM memory_items_all AS item WHERE item.id = ANY($2::uuid[])`,
      [cardId, input.readIds],
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
         error_code = NULL
       WHERE ${LEASED_BUILD_SQL}`,
      [input.buildId, input.leaseToken, version, input.inputRecords, input.cited.length],
    );
    if (finished.rowCount !== 1) throw leaseLost();
    return { cardVersion: version };
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
}): Promise<boolean> {
  const result = await database().query(
    `UPDATE person_card_builds SET status = 'failed', finished_at = now(), lease_token = NULL,
       lease_expires_at = NULL, error_code = $3, input_records = $4
     WHERE ${LEASED_BUILD_SQL}`,
    [input.buildId, input.leaseToken, input.errorCode, input.inputRecords],
  );
  return result.rowCount === 1;
}
