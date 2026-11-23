/**
 * Migration 152 against PostgreSQL.
 *
 * Constructs covered:
 * - The builds the previous release queued and never ran go; one back after an unclear model
 *   outcome keeps its paid attempts; the paid-failure column is gone.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import {
  createPersonCardFixture,
  resetPersonCardTables,
  YURA_TELEGRAM_ID,
  type PersonCardFixture,
} from "./person-card.integration-fixtures.js";

const describeWithDatabase =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("152 person card builds without paid failures", () => {
  let fixture: PersonCardFixture;

  beforeEach(async () => {
    await resetPersonCardTables();
    fixture = await createPersonCardFixture();
  });

  afterAll(closeDatabase);

  const yuraKey = () => ({
    area: "group" as const,
    areaKey: fixture.groupA.id,
    familyId: fixture.familyId,
    subjectTelegramUserId: YURA_TELEGRAM_ID,
  });

  // Review of the fixes, 23 November 2026: a build the previous release queued (the person's own
  // words rebuilt at once) would be claimed without the daily rule; migration 152 drops it, and the
  // queue asks again by the new rules.
  it("drops the builds the previous release left pending (migration 152)", async () => {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "ALTER TABLE person_card_builds ADD COLUMN possibly_paid boolean NOT NULL DEFAULT false",
      );
      const key = yuraKey();
      const build = (status: string) =>
        client.query(
          `INSERT INTO person_card_builds
             (family_id, area, area_key, subject_telegram_user_id, reason, status, attempts,
              started_at, finished_at)
           VALUES ($1, $2, $3, $4, 'self_statement', $5, 1, now(), now())`,
          [key.familyId, key.area, key.areaKey, key.subjectTelegramUserId, status],
        );
      await build("succeeded");
      await client.query(
        `INSERT INTO person_card_builds (family_id, area, area_key, subject_telegram_user_id, reason)
         VALUES ($1, $2, $3, $4, 'self_statement')`,
        [key.familyId, key.area, key.areaKey, key.subjectTelegramUserId],
      );
      // A build back after an unclear model outcome already paid its attempts: it stays.
      await client.query(
        `INSERT INTO person_card_builds (family_id, area, area_key, subject_telegram_user_id,
           reason, attempts, retry_after)
         VALUES ($1, $2, 'b0000000-0000-4000-8000-000000000001', $3, 'self_statement', 2,
                 now() + interval '10 minutes')`,
        [key.familyId, key.area, key.subjectTelegramUserId],
      );
      await client.query(
        await readFile(
          resolve("migrations/152_person_card_builds_without_paid_failures.sql"),
          "utf8",
        ),
      );
      const left = await client.query<{ attempts: number; status: string }>(
        "SELECT status, attempts FROM person_card_builds ORDER BY status",
      );
      expect(left.rows).toEqual([
        { attempts: 2, status: "pending" },
        { attempts: 1, status: "succeeded" },
      ]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
