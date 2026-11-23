/**
 * The build queue of person cards.
 *
 * Exports:
 * - `ClaimedPersonCardBuild`: a build this process holds the lease of.
 * - `personCardDispatchRepository`: reclaim, purge, enqueue due cards, claim, release for retry.
 *
 * Key constructs:
 * - Due: one build of a card a day at most, counted from the end of its last build, failed or not
 *   (owner, 23 November 2026: the person's own words rebuilt the card at once, 72 of 147 builds a
 *   day on production). After the day: the person's own words about themselves (a firsthand
 *   statement or confirmation) after the card's snapshot, quiet for two minutes; a cited record
 *   that no longer stands (meanwhile the turn drops just the items citing it); ten or more records
 *   the card did not read (`person_card_reads`). The weekly count of possibly paid failures is gone:
 *   the day bounds every card, a failing one included. One open build per card (a partial unique
 *   index); its attempts on an unclear model outcome are one build.
 * - A lease that ran out means the process is gone: the build published nothing and goes back to
 *   pending until its attempts run out.
 * - Claims serialize on an advisory lock so two overlapping minute ticks never run more builds
 *   than the limit; no build starts while a deploy pauses new turns.
 * - A card none of whose cited records still stands goes: its area's records were purged (a group
 *   that changed type is deleted with its memory), deleted, or made sensitive.
 */
import { database } from "../database.js";
import { TURN_START_LOCK_SQL, TURN_START_PAUSED_SQL } from "../deploy/turn-start-pause.js";
import {
  PERSON_CARD_LEASE_MILLISECONDS,
  PERSON_CARD_MAX_ATTEMPTS,
  PERSON_CARD_NEW_RECORDS_THRESHOLD,
  PERSON_CARD_REBUILD_INTERVAL_MILLISECONDS,
  PERSON_CARD_SELF_STATEMENT_QUIET_MILLISECONDS,
} from "./person-card-config.js";
import { personCardTransaction } from "./person-card-transaction.js";
import {
  personCardLinksSql,
  personCardSourceAliveSql,
  type PersonCardKey,
} from "./person-card-links.js";

export type PersonCardBuildReason = "invalidated" | "new_records" | "self_statement";

export interface ClaimedPersonCardBuild {
  attempts: number;
  id: string;
  key: PersonCardKey;
  leaseToken: string;
  reason: PersonCardBuildReason;
}

interface KeyRow {
  area: PersonCardKey["area"];
  area_key: string;
  family_id: string;
  reason: PersonCardBuildReason;
  subject_telegram_user_id: string;
}

interface BuildRow extends KeyRow {
  attempts: number;
  id: string;
  lease_token: string;
}

const KEY_MATCH = (left: string, right: string) =>
  `${left}.family_id = ${right}.family_id AND ${left}.area = ${right}.area
   AND ${left}.area_key = ${right}.area_key
   AND ${left}.subject_telegram_user_id = ${right}.telegram_user_id`;

/**
 * The scan joins a few thousand records; PostgreSQL's estimate makes it compile the plan with JIT
 * (1.5 s instead of 60 ms on a test with 9 000 records and 114 cards), every minute.
 */
const WITHOUT_JIT = { setup: ["SET LOCAL jit = off"] };

/** The build is still this worker's: checked under the build row's lock before publishing too. */
export const LEASED_BUILD_SQL =
  "id = $1 AND status = 'running' AND lease_token = $2 AND lease_expires_at > clock_timestamp()";

// A finished build is history the queue no longer reads after a day.
const BUILD_HISTORY_DAYS = 30;

export const personCardDispatchRepository = {
  /** Running builds whose lease ran out: back to pending, or failed once attempts are spent. */
  async reclaimExpired(): Promise<{ failed: number; retried: number }> {
    const result = await database().query<{ status: string }>(
      `UPDATE person_card_builds SET
         status = CASE WHEN attempts >= $1 THEN 'failed' ELSE 'pending' END,
         finished_at = CASE WHEN attempts >= $1 THEN now() END,
         error_code = CASE WHEN attempts >= $1 THEN 'AGENT_PERSON_CARD_BUILD_ABANDONED'
                           ELSE error_code END,
         lease_token = NULL, lease_expires_at = NULL
       WHERE status = 'running' AND lease_expires_at <= now()
       RETURNING status`,
      [PERSON_CARD_MAX_ATTEMPTS],
    );
    const failed = result.rows.filter((row) => row.status === "failed").length;
    return { failed, retried: result.rows.length - failed };
  },

  /**
   * Cards none of whose cited records still stand (nothing is left to show or to rebuild from), and
   * finished builds older than a month.
   */
  async purgeOrphans(): Promise<number> {
    await database().query(
      "DELETE FROM person_card_builds WHERE finished_at < now() - make_interval(days => $1)",
      [BUILD_HISTORY_DAYS],
    );
    const result = await database().query(
      `DELETE FROM person_cards AS card
       WHERE NOT EXISTS (
         -- An open build, or one within the day: the daily rebuild is queued before the purge.
         SELECT 1 FROM person_card_builds AS recent
         WHERE recent.family_id = card.family_id AND recent.area = card.area
           AND recent.area_key = card.area_key
           AND recent.subject_telegram_user_id = card.subject_telegram_user_id
           AND (recent.status IN ('pending', 'running')
                OR COALESCE(recent.finished_at, recent.requested_at) > now() - $1::interval)
       )
       AND NOT EXISTS (
         SELECT 1 FROM person_card_sources AS source
         JOIN memory_items AS cited ON cited.id = source.memory_item_id
         WHERE source.card_id = card.id
           AND ${personCardSourceAliveSql({ card: "card", cited: "cited", source: "source" })}
       )`,
      [`${PERSON_CARD_REBUILD_INTERVAL_MILLISECONDS} milliseconds`],
    );
    return result.rowCount ?? 0;
  },

  /** Inserts a pending build for every due person; returns what was queued. */
  async enqueueDue(): Promise<Array<{ key: PersonCardKey; reason: PersonCardBuildReason }>> {
    const result = await personCardTransaction(
      (client) =>
        client.query<KeyRow>(
          `WITH ${personCardLinksSql("$1")},
       subjects AS (
         SELECT links.family_id, links.area, links.area_key, links.telegram_user_id,
                card.id AS card_id, card.sources_as_of, card.source_count,
                count(*) FILTER (
                  WHERE links.kind <> 'episode' AND NOT EXISTS (
                    SELECT 1 FROM person_card_reads AS known
                    WHERE known.card_id = card.id AND known.memory_item_id = links.memory_item_id
                  )
                ) AS new_records,
                max(links.self_statement_at) AS newest_self
         FROM links
         LEFT JOIN person_cards AS card ON ${KEY_MATCH("card", "links")}
         GROUP BY links.family_id, links.area, links.area_key, links.telegram_user_id,
                  card.id, card.sources_as_of, card.source_count
       ),
       candidates AS (
         SELECT subjects.*,
                (SELECT max(COALESCE(build.finished_at, build.requested_at))
                 FROM person_card_builds AS build
                 WHERE ${KEY_MATCH("build", "subjects")}) AS last_active,
                (subjects.card_id IS NOT NULL AND (
                  SELECT count(*) FROM person_cards AS card
                  JOIN person_card_sources AS source ON source.card_id = card.id
                  JOIN memory_items AS cited ON cited.id = source.memory_item_id
                  WHERE card.id = subjects.card_id
                    AND ${personCardSourceAliveSql({ card: "card", cited: "cited", source: "source" })}
                ) < subjects.source_count) AS invalid
         FROM subjects
         WHERE NOT EXISTS (
           SELECT 1 FROM person_card_builds AS open_build
           WHERE ${KEY_MATCH("open_build", "subjects")} AND open_build.status IN ('pending', 'running')
         )
       ),
       due AS (
         SELECT family_id, area, area_key, telegram_user_id, CASE
           WHEN last_active > now() - $3::interval THEN NULL
           WHEN card_id IS NOT NULL AND newest_self > sources_as_of
             AND newest_self <= now() - $2::interval THEN 'self_statement'
           WHEN invalid THEN 'invalidated'
           WHEN new_records >= $4 THEN 'new_records'
         END AS reason
         FROM candidates
       )
       INSERT INTO person_card_builds (family_id, area, area_key, subject_telegram_user_id, reason)
       SELECT family_id, area, area_key, telegram_user_id, reason FROM due WHERE reason IS NOT NULL
       ON CONFLICT DO NOTHING
       RETURNING family_id, area, area_key, subject_telegram_user_id, reason`,
          [
            null,
            `${PERSON_CARD_SELF_STATEMENT_QUIET_MILLISECONDS} milliseconds`,
            `${PERSON_CARD_REBUILD_INTERVAL_MILLISECONDS} milliseconds`,
            PERSON_CARD_NEW_RECORDS_THRESHOLD,
          ],
        ),
      WITHOUT_JIT,
    );
    return result.rows.map((row) => ({ key: toKey(row), reason: row.reason }));
  },

  async claim(maxRunning: number): Promise<ClaimedPersonCardBuild[]> {
    const result = await personCardTransaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('osinara.person_card_claim', 0))",
      );
      // Shared with every other claim: the deploy sets its pause under this lock taken alone.
      await client.query(TURN_START_LOCK_SQL);
      return client.query<BuildRow>(
        `WITH picked AS (
           SELECT id FROM person_card_builds
           WHERE status = 'pending' AND (retry_after IS NULL OR retry_after <= now())
             AND NOT ${TURN_START_PAUSED_SQL}
           ORDER BY requested_at, id
           LIMIT GREATEST(0, $1 - (SELECT count(*) FROM person_card_builds WHERE status = 'running'))
           FOR UPDATE SKIP LOCKED
         )
         UPDATE person_card_builds AS build SET status = 'running',
           lease_token = gen_random_uuid(), lease_expires_at = now() + $2::interval,
           attempts = build.attempts + 1, started_at = now(), retry_after = NULL
         FROM picked WHERE build.id = picked.id
         RETURNING build.id, build.family_id, build.area, build.area_key,
                   build.subject_telegram_user_id, build.reason, build.attempts, build.lease_token`,
        [maxRunning, `${PERSON_CARD_LEASE_MILLISECONDS} milliseconds`],
      );
    });
    return result.rows.map((row) => ({
      attempts: row.attempts,
      id: row.id,
      key: toKey(row),
      leaseToken: row.lease_token,
      reason: row.reason,
    }));
  },

  /**
   * A model call with an unclear outcome: the build goes back to the queue after a pause, or fails
   * once its attempts are spent. Returns whether it will be retried.
   */
  async releaseForRetry(input: {
    buildId: string;
    errorCode: string;
    leaseToken: string;
  }): Promise<"failed" | "lost" | "retry"> {
    const result = await database().query<{ status: string }>(
      `UPDATE person_card_builds SET
         status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
         finished_at = CASE WHEN attempts >= $3 THEN now() END,
         retry_after = CASE WHEN attempts >= $3 THEN NULL
                            ELSE now() + attempts * interval '5 minutes' END,
         error_code = $4,
         lease_token = NULL, lease_expires_at = NULL
       WHERE ${LEASED_BUILD_SQL}
       RETURNING status`,
      [input.buildId, input.leaseToken, PERSON_CARD_MAX_ATTEMPTS, input.errorCode],
    );
    const status = result.rows[0]?.status;
    return status === undefined ? "lost" : status === "pending" ? "retry" : "failed";
  },

  async stillLeased(buildId: string, leaseToken: string): Promise<boolean> {
    const result = await database().query(
      `SELECT 1 FROM person_card_builds WHERE ${LEASED_BUILD_SQL}`,
      [buildId, leaseToken],
    );
    return result.rowCount === 1;
  },
};

function toKey(row: KeyRow): PersonCardKey {
  return {
    area: row.area,
    areaKey: row.area_key,
    familyId: row.family_id,
    subjectTelegramUserId: row.subject_telegram_user_id,
  };
}
