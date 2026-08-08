/**
 * Family-private extraction authorization integration tests.
 *
 * Constructs covered:
 * - Non-member source entries are terminally excluded before snapshot/provider work.
 * - Every primary and supporting author is re-authorized before claim persistence.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { conversationRepository } from "./conversation-repository.js";
import { closeDatabase, database } from "./database.js";
import { createCatchUpExtractionBatches } from "./memory-extraction-batch-coordinator.js";
import { processMemoryExtractionCandidates } from "./memory-extraction-candidate-processor.js";
import { memoryExtractionRepository } from "./memory-extraction-repository.js";
import {
  completeExtractionBatch as completeBatch,
  createExtractionFamily as createFamily,
  createExtractionGroup as createGroup,
  createExtractionMember as createMember,
  insertExtractionEntry as insertEntry,
} from "./r2b-unified-timeline-extraction-fixtures.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

describeWithDatabase("family extraction authorization", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE memory_extraction_batches, claim_evidence, memory_items,
         telegram_group_messages, telegram_groups, family_memberships, users, families CASCADE`,
    );
  });

  afterAll(closeDatabase);

  it("excludes every non-member family source before snapshot and provider work", async () => {
    const familyId = await createFamily("Family source authorization");
    await createMember({ familyId, name: "Анна", role: "owner", telegramUserId: "7351" });
    const outsider = await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('7352', 'Посторонний') RETURNING id",
    );
    const groupId = await createGroup({ familyId, idSuffix: "7350", type: "family_private" });
    const allowedEntry = await insertEntry({
      content: "Ремонт продолжаем в сентябре", groupId, messageId: 1, sequence: 1,
      telegramUserId: "7351", userName: "Анна",
    });
    const deniedEntry = await insertEntry({
      content: "Секрет постороннего", groupId, messageId: 2, sequence: 2,
      telegramUserId: "7352", userName: "Посторонний",
    });
    const conversation = await conversationRepository.getByGroupId(groupId);

    await expect(createCatchUpExtractionBatches()).resolves.toBe(1);

    const snapshots = await database().query<{ content_text: string }>(
      `SELECT content_text FROM memory_extraction_snapshot_entries
       WHERE conversation_id = $1 ORDER BY sequence_id`,
      [conversation.id],
    );
    expect(snapshots.rows).toEqual([{ content_text: "Ремонт продолжаем в сентябре" }]);
    await expect(database().query(
      `SELECT diagnostic_code FROM memory_extraction_gaps
       WHERE conversation_id = $1 AND first_sequence = 2 AND last_sequence = 2`,
      [conversation.id],
    )).resolves.toMatchObject({
      rows: [{ diagnostic_code: "AGENT_MEMORY_EXTRACTION_FAMILY_SOURCE_DENIED" }],
    });
    await expect(database().query(
      "SELECT timeline_entry_id FROM memory_extraction_retention_holds WHERE timeline_entry_id = $1",
      [deniedEntry],
    )).resolves.toMatchObject({ rowCount: 0 });
    expect(allowedEntry).not.toBe(deniedEntry);
    expect(outsider.rows[0]?.id).toBeDefined();
  });

  it("rejects a candidate when any family supporting author loses membership", async () => {
    const familyId = await createFamily("Supporting source authorization");
    await createMember({ familyId, name: "Анна", role: "owner", telegramUserId: "7361" });
    const petrId = await createMember({
      familyId, name: "Пётр", role: "member", telegramUserId: "7362",
    });
    const groupId = await createGroup({ familyId, idSuffix: "7360", type: "family_private" });
    const primary = await insertEntry({
      content: "Ремонт продолжаем в сентябре", groupId, messageId: 1, sequence: 1,
      telegramUserId: "7361", userName: "Анна",
    });
    const supporting = await insertEntry({
      content: "Подтверждаю срок", groupId, messageId: 2, sequence: 2,
      telegramUserId: "7362", userName: "Пётр",
    });
    const conversation = await conversationRepository.getByGroupId(groupId);
    const batch = await memoryExtractionRepository.createBatch({
      applicationSessionId: null, callerTelegramUserId: "7361", conversationId: conversation.id,
      extractorVersion: "supporting-auth-test", firstSequence: "1", lastSequence: "2",
      omittedBeforeSequence: null, schemaVersion: "supporting-auth-test",
      timelineEntryIds: [primary, supporting], turnId: "supporting-auth",
    });
    await completeBatch({
      action: "save", batchId: batch.id, content: "Ремонт продолжается в сентябре.",
      primarySnapshotEntryId: batch.snapshotEntries[0]!.id, sensitivity: "normal",
      supportingSnapshotEntryIds: [batch.snapshotEntries[1]!.id],
    });
    await database().query(
      "DELETE FROM family_memberships WHERE family_id = $1 AND user_id = $2",
      [familyId, petrId],
    );

    await expect(processMemoryExtractionCandidates(batch.id)).resolves.toBe(1);
    await expect(database().query(
      "SELECT resolution_status, resolution_diagnostic_code FROM memory_extraction_candidates WHERE batch_id = $1",
      [batch.id],
    )).resolves.toMatchObject({ rows: [{
      resolution_diagnostic_code: "AGENT_MEMORY_EVIDENCE_AUTHOR_NOT_MEMBER",
      resolution_status: "resolution_failed",
    }] });
    await expect(database().query(
      "SELECT 1 FROM memory_items WHERE content = 'Ремонт продолжается в сентябре.'",
    )).resolves.toMatchObject({ rowCount: 0 });
  });
});
