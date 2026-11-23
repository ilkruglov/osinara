/**
 * A card publish against another writer locking the same memory records.
 *
 * Constructs covered:
 * - The publish locks the records it read in creation order; resolving a conflict locks its two
 *   records in the order its query reads them (`memory-conflict-repository.ts`). When the two
 *   deadlock, PostgreSQL aborts one side; an aborted publish runs again instead of failing a paid
 *   build (review of the fixes, 23 November 2026: the retry had been removed with the cleanup).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { waitForLockWaiters } from "../database-lock.integration-fixtures.js";
import { personCardDispatchRepository } from "./person-card-dispatch-repository.js";
import { publishPersonCard } from "./person-card-publish-repository.js";
import { loadPersonCardSources } from "./person-card-sources-repository.js";
import {
  createPersonCardFixture,
  insertPersonCardRecord,
  resetPersonCardTables,
  YURA_TELEGRAM_ID,
  type PersonCardFixture,
} from "./person-card.integration-fixtures.js";

const describeWithDatabase =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("person card publish locks", () => {
  let fixture: PersonCardFixture;

  beforeEach(async () => {
    await resetPersonCardTables();
    fixture = await createPersonCardFixture();
  });

  afterAll(closeDatabase);

  it("publishes after losing a deadlock to a conflict resolution", async () => {
    const record = (content: string, hoursAgo: number) =>
      insertPersonCardRecord(fixture, {
        content,
        conversationId: fixture.groupA.conversationId,
        createdAt: new Date(Date.now() - hoursAgo * 60 * 60_000),
        groupId: fixture.groupA.id,
        scope: "group",
        subjectLabel: "Юра (yura_k)",
      });
    for (let index = 0; index < 8; index += 1) await record(`Юра ${index}`, 10 - index / 100);
    // The conflict's first record is the newer one: the publish reaches it second.
    let first = "";
    let second = "";
    for (let tries = 0; tries < 20 && first === ""; tries += 1) {
      const older = await record(`старое ${tries}`, 2);
      const newer = await record(`новое ${tries}`, 1);
      if (newer.id < older.id) {
        first = newer.id;
        second = older.id;
      }
    }
    expect(first).not.toBe("");
    const key = {
      area: "group" as const,
      areaKey: fixture.groupA.id,
      familyId: fixture.familyId,
      subjectTelegramUserId: YURA_TELEGRAM_ID,
    };
    expect(await personCardDispatchRepository.enqueueDue()).toHaveLength(1);
    const [claimed] = await personCardDispatchRepository.claim(2);
    const sources = await loadPersonCardSources(key);
    // The conflict appears while the model answers.
    const conflict = await database().query<{ conflict_ref: string }>(
      `INSERT INTO claim_conflicts (claim_a_id, claim_b_id, family_id, scope, scope_partition_key,
         detection_method)
       VALUES ($1, $2, $3, 'group', $4, 'user_reported') RETURNING conflict_ref`,
      [first, second, fixture.familyId, fixture.groupA.id],
    );
    const holder = await database().connect();
    const resolver = await database()
      .connect()
      .catch((error: unknown) => {
        holder.release();
        throw error;
      });
    try {
      // A reader of the second record holds the resolution after it took the first.
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM memory_items_all WHERE id = $1 FOR KEY SHARE", [second]);
      await resolver.query("BEGIN");
      const resolving = resolver
        .query(
          `SELECT conflict.id
           FROM claim_conflicts AS conflict
           JOIN memory_items AS a ON a.id = conflict.claim_a_id
           JOIN memory_items AS b ON b.id = conflict.claim_b_id
           JOIN memory_item_refs AS ref_a ON ref_a.memory_item_id = a.id
           JOIN memory_item_refs AS ref_b ON ref_b.memory_item_id = b.id
           WHERE conflict.conflict_ref = $1 AND conflict.family_id = $2
           FOR UPDATE OF conflict, a, b`,
          [conflict.rows[0]!.conflict_ref, fixture.familyId],
        )
        .then(
          async () => {
            await resolver.query("COMMIT");
            return "resolved";
          },
          async (error: { code?: string }) => {
            await resolver.query("ROLLBACK");
            return `resolution ${error.code}`;
          },
        );
      await waitForLockWaiters(1);
      const publishing = publishPersonCard({
        buildId: claimed!.id,
        characters: 7,
        cited: sources.records,
        inputRecords: sources.records.length,
        key,
        leaseToken: claimed!.leaseToken,
        readIds: sources.readIds,
        sections: {
          communication: [{ scope: "всегда", sourceRefs: [], text: "Коротко" }],
          facts: [],
          interests: [],
          positions: [],
        },
        sourcesAsOf: sources.sourcesAsOf,
        subjectLabel: sources.subjectLabel,
      }).then(
        () => "published",
        (error: { code?: string }) => `publish ${error.code}`,
      );
      await waitForLockWaiters(2);
      await holder.query("COMMIT");
      // PostgreSQL aborted the publish (it waited first); it ran again after the resolution.
      expect(await Promise.all([resolving, publishing])).toEqual(["resolved", "published"]);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await resolver.query("ROLLBACK").catch(() => undefined);
      holder.release();
      resolver.release();
    }
  }, 30_000);
});
