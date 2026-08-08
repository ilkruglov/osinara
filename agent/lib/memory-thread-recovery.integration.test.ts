/**
 * Memory-thread recovery progress integration tests.
 *
 * Constructs covered:
 * - Old recovery seeds are marked considered without creating provider work.
 * - An empty/out-of-window cluster cannot starve the shared memory worker.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { processMemoryExtractionCandidates } from "./memory-extraction-candidate-processor.js";
import { memoryExtractionRepository } from "./memory-extraction-repository.js";
import { memoryThreadDiscoveryRepository } from "./memory-thread-discovery-repository.js";
import {
  completeExtractionBatch,
  createExtractionFamily,
  createExtractionGroup,
  insertExtractionEntry,
} from "./r2b-unified-timeline-extraction-fixtures.js";
import { conversationRepository } from "./conversation-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

describeWithDatabase("memory thread recovery progress", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("marks an old seed considered and returns idle on the following pass", async () => {
    const familyId = await createExtractionFamily("Old thread seed");
    const groupId = await createExtractionGroup({ familyId, idSuffix: "8991", type: "external" });
    const source = await insertExtractionEntry({
      content: "Давний завершённый проект", groupId, messageId: 1, sequence: 1,
      telegramUserId: "8992", userName: "Анна",
    });
    const conversation = await conversationRepository.getByGroupId(groupId);
    const batch = await memoryExtractionRepository.createBatch({
      applicationSessionId: null,
      callerTelegramUserId: "8992",
      conversationId: conversation.id,
      extractorVersion: "thread-old-seed",
      firstSequence: "1",
      lastSequence: "1",
      omittedBeforeSequence: null,
      schemaVersion: "thread-old-seed",
      timelineEntryIds: [source],
      turnId: "thread-old-seed",
    });
    await completeExtractionBatch({
      action: "save",
      batchId: batch.id,
      content: "Давний завершённый проект.",
      primarySnapshotEntryId: batch.snapshotEntries[0]!.id,
      sensitivity: "normal",
    });
    await processMemoryExtractionCandidates(batch.id);
    const claim = await database().query<{ id: string }>(
      "SELECT id FROM memory_items WHERE content = 'Давний завершённый проект.'",
    );
    await database().query(
      "UPDATE memory_items SET embedding_status = 'indexed' WHERE id = $1",
      [claim.rows[0]!.id],
    );
    await database().query(
      "UPDATE claim_evidence SET observed_at = now() - interval '91 days' WHERE claim_id = $1",
      [claim.rows[0]!.id],
    );

    await expect(memoryThreadDiscoveryRepository.stageRecoveryCandidate()).resolves.toBe(true);
    await expect(database().query(
      "SELECT last_job_id FROM memory_thread_discovery_claim_coverage WHERE source_claim_id = $1",
      [claim.rows[0]!.id],
    )).resolves.toMatchObject({ rows: [{ last_job_id: null }] });
    await expect(memoryThreadDiscoveryRepository.stageRecoveryCandidate()).resolves.toBe(false);
    await expect(database().query("SELECT 1 FROM memory_thread_discovery_jobs"))
      .resolves.toMatchObject({ rowCount: 0 });
  });
});
