/**
 * Memory extraction sequence-range repair integration test.
 *
 * Constructs covered:
 * - Migration 057 derives exact numeric range boundaries from immutable snapshot entries.
 * - Reapplying the data repair is idempotent.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { memoryExtractionRepository } from "./memory-extraction-repository.js";
import {
  createExtractionFamily as createFamily,
  createExtractionGroup as createGroup,
  insertExtractionEntry as insertEntry,
} from "./r2b-unified-timeline-extraction-fixtures.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

describeWithDatabase("memory extraction numeric sequence repair", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE memory_extraction_batches, telegram_group_messages, telegram_groups,
         family_memberships, users, families CASCADE`,
    );
  });

  afterAll(closeDatabase);

  it("repairs persisted range boundaries from snapshot sequence values", async () => {
    const familyId = await createFamily("Sequence repair");
    const groupId = await createGroup({ familyId, idSuffix: "9757", type: "external" });
    const firstEntry = await insertEntry({
      content: "Первая запись", groupId, messageId: 1, sequence: 1,
      telegramUserId: "1", userName: "Анна",
    });
    const secondEntry = await insertEntry({
      content: "Вторая запись", groupId, messageId: 2, sequence: 2,
      telegramUserId: "1", userName: "Анна",
    });
    const conversation = await database().query<{ id: string }>(
      "SELECT id FROM application_conversations WHERE telegram_group_id = $1",
      [groupId],
    );
    const batch = await memoryExtractionRepository.createBatch({
      applicationSessionId: null,
      callerTelegramUserId: null,
      conversationId: conversation.rows[0]!.id,
      extractorVersion: "semantic-extractor-v1",
      firstSequence: "1",
      lastSequence: "2",
      omittedBeforeSequence: null,
      schemaVersion: "memory-candidate-v2",
      timelineEntryIds: [firstEntry, secondEntry],
      turnId: "repair-range",
    });
    await database().query(
      "UPDATE memory_extraction_ranges SET last_sequence = 1 WHERE batch_id = $1",
      [batch.id],
    );

    // The migration is data-only and must remain safe if an operator verifies it more than once.
    const migration = await readFile(
      resolve("migrations/057_repair_memory_extraction_sequence_ranges.sql"),
      "utf8",
    );
    await database().query(migration);
    await database().query(migration);

    await expect(database().query<{ first: string; last: string }>(
      `SELECT first_sequence::text AS first, last_sequence::text AS last
       FROM memory_extraction_ranges WHERE batch_id = $1`,
      [batch.id],
    )).resolves.toMatchObject({ rows: [{ first: "1", last: "2" }] });
  });
});
