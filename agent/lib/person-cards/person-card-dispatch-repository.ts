/**
 * The build queue of person cards.
 *
 * Exports:
 * - `ClaimedPersonCardBuild`: a build this process holds the lease of.
 * - `personCardDispatchRepository`: reclaim, purge, enqueue due cards, claim, release for retry.
 *
 * Key constructs:
 * - Due (the owner's decisions of 21 November 2026): ten or more records about the person the card
 *   did not read (`person_card_reads`), at most once a day counted from the end of the last build;
 *   the person's own words about themselves (a firsthand statement or confirmation) after the card's
 *   snapshot and after the last request, quiet for two minutes, rebuild an existing card at once (a
 *   failed request stops counting after a back-off, so the words are not lost); a card with a cited
 *   record that no longer stands is rebuilt once a day (meanwhile the turn drops just the items
 *   citing it). Ten failed builds in a week stop the person's builds until the week has passed,
 *   counting a build when any of its attempts may have been paid.
 *   One open build per person and area (a partial unique index).
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
  PERSON_CARD_FAILED_RETRY_BACKOFF_MILLISECONDS,
  PERSON_CARD_MAX_FAILED_BUILDS_PER_WEEK,
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

// A finished build without a cleanup row is history the queue no longer reads after a day.
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
         -- The run may have died in the middle of a model call (a deploy).
         possibly_paid = true,
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
   * finished builds older than a month that cleaned nothing.
   */
  async purgeOrphans(): Promise<number> {
    await database().query(
      `DELETE FROM person_card_builds AS build
       WHERE build.finished_at < now() - make_interval(days => $1)
         AND NOT EXISTS (SELECT 1 FROM person_card_cleanups AS cleanup
                         WHERE cleanup.build_id = build.id)`,
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
         SELECT subjects.*, last_build.active_at AS last_active, last_build.self_requested_at,
                last_build.failed_this_week,
                (subjects.card_id IS NOT NULL AND (
                  SELECT count(*) FROM person_cards AS card
                  JOIN person_card_sources AS source ON source.card_id = card.id
                  JOIN memory_items AS cited ON cited.id = source.memory_item_id
                  WHERE card.id = subjects.card_id
                    AND ${personCardSourceAliveSql({ card: "card", cited: "cited", source: "source" })}
                ) < subjects.source_count) AS invalid
         FROM subjects
         LEFT JOIN LATERAL (
           SELECT max(COALESCE(build.finished_at, build.requested_at)) AS active_at,
                  -- A failed build stops answering the person's words only for the back-off.
                  max(build.requested_at) FILTER (
                    WHERE build.status <> 'failed' OR build.finished_at > now() - $5::interval
                  ) AS self_requested_at,
                  (SELECT count(*) FROM person_card_builds AS failed
                   WHERE failed.family_id = subjects.family_id
                     AND failed.subject_telegram_user_id = subjects.telegram_user_id
                     AND failed.status = 'failed'
                     AND failed.finished_at > now() - interval '7 days'
                     AND failed.possibly_paid) AS failed_this_week
           FROM person_card_builds AS build
           WHERE ${KEY_MATCH("build", "subjects")}
         ) AS last_build ON true
         WHERE NOT EXISTS (
           SELECT 1 FROM person_card_builds AS open_build
           WHERE ${KEY_MATCH("open_build", "subjects")} AND open_build.status IN ('pending', 'running')
         )
       ),
       due AS (
         SELECT family_id, area, area_key, telegram_user_id, CASE
           -- A person whose builds keep failing waits for next week: each attempt is paid.
           WHEN failed_this_week >= $6 THEN NULL
           WHEN card_id IS NOT NULL
             AND newest_self > GREATEST(sources_as_of, COALESCE(self_requested_at, '-infinity'::timestamptz))
             AND newest_self <= now() - $2::interval THEN 'self_statement'
           WHEN invalid AND (last_active IS NULL OR last_active <= now() - $3::interval)
             THEN 'invalidated'
           WHEN new_records >= $4
             AND (last_active IS NULL OR last_active <= now() - $3::interval) THEN 'new_records'
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
            `${PERSON_CARD_FAILED_RETRY_BACKOFF_MILLISECONDS} milliseconds`,
            PERSON_CARD_MAX_FAILED_BUILDS_PER_WEEK,
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
    /** The attempt may have cost a model call (`possibly_paid`, the weekly cap). */
    possiblyPaid: boolean;
  }): Promise<"failed" | "lost" | "retry"> {
    const result = await database().query<{ status: string }>(
      `UPDATE person_card_builds SET
         status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
         finished_at = CASE WHEN attempts >= $3 THEN now() END,
         retry_after = CASE WHEN attempts >= $3 THEN NULL
                            ELSE now() + attempts * interval '5 minutes' END,
         error_code = $4, possibly_paid = possibly_paid OR $5,
         lease_token = NULL, lease_expires_at = NULL
       WHERE ${LEASED_BUILD_SQL}
       RETURNING status`,
      [
        input.buildId,
        input.leaseToken,
        PERSON_CARD_MAX_ATTEMPTS,
        input.errorCode,
        input.possiblyPaid,
      ],
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
