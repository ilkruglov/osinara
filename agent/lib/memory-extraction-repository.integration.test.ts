/**
 * Durable memory extraction repository integration tests.
 *
 * Constructs covered:
 * - Exact bounded snapshots survive source timeline pruning until explicit terminal erasure.
 * - Jobs lease once, persist provider-call markers, and complete empty or with atomic candidates.
 * - Completion is idempotent, partial output is explicit, and failed work never retries implicitly.
 * - Operator requeue uses a safe reset or a new bounded attempt according to provider-call state.
 * - Extraction range state is independent from the Eve conversation session cursor.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { conversationRepository } from "./conversation-repository.js";
import { closeDatabase, database } from "./database.js";
import { memoryExtractionRepository } from "./memory-extraction-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

interface ExtractionFixture {
  conversationId: string;
  entryIds: string[];
  familyId: string;
  groupId: string;
}

async function createFixture(suffix: string): Promise<ExtractionFixture> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ($1) RETURNING id",
    [`Extraction ${suffix}`],
  );
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, $2, $3, 'external', 'addressed_only') RETURNING id`,
    [family.rows[0]!.id, `-1009${suffix}`, `Группа ${suffix}`],
  );
  const entries = await database().query<{ id: string }>(
    `INSERT INTO telegram_group_messages
       (group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind,
        content_text, sent_at)
     VALUES ($1, 11, 1, 'user', 'telegram:901', '901', 'Анна', false, 'text',
             'Я работаю дома по вторникам', now() - interval '1 minute'),
            ($1, 12, 2, 'user', 'telegram:902', '902', 'Пётр', false, 'text',
             'Летом едем в Казань', now())
     RETURNING id`,
    [group.rows[0]!.id],
  );
  const conversation = await conversationRepository.getByGroupId(group.rows[0]!.id);
  return {
    conversationId: conversation.id,
    entryIds: entries.rows.map((row) => row.id),
    familyId: family.rows[0]!.id,
    groupId: group.rows[0]!.id,
  };
}

describeWithDatabase("memoryExtractionRepository", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE memory_extraction_batches, claim_evidence, memory_items,
         telegram_group_messages, telegram_groups, family_memberships, users, families CASCADE`,
    );
  });

  afterAll(closeDatabase);

  it("creates an exact snapshot and completes multiple same-source candidates idempotently", async () => {
    const fixture = await createFixture("701");
    const batch = await memoryExtractionRepository.createBatch({
      applicationSessionId: null,
      callerTelegramUserId: null,
      conversationId: fixture.conversationId,
      extractorVersion: "extractor-test-v1",
      firstSequence: "1",
      lastSequence: "2",
      omittedBeforeSequence: null,
      schemaVersion: "memory-candidate-v1",
      timelineEntryIds: fixture.entryIds,
      turnId: "turn-exact-701",
    });

    expect(batch.snapshotEntries.map((entry) => entry.contentText)).toEqual([
      "Я работаю дома по вторникам",
      "Летом едем в Казань",
    ]);
    await database().query("DELETE FROM telegram_group_messages WHERE group_id = $1", [fixture.groupId]);
    const retained = await database().query<{
      content_text: string;
      timeline_entry_id: string | null;
    }>(
      `SELECT content_text, timeline_entry_id FROM memory_extraction_snapshot_entries
       WHERE batch_id = $1 ORDER BY sequence_id`,
      [batch.id],
    );
    expect(retained.rows).toEqual([
      { content_text: "Я работаю дома по вторникам", timeline_entry_id: null },
      { content_text: "Летом едем в Казань", timeline_entry_id: null },
    ]);

    const job = await memoryExtractionRepository.claimPending();
    expect(job?.batchId).toBe(batch.id);
    await memoryExtractionRepository.markProviderCallStarted(job!.id, job!.leaseToken);
    const primary = batch.snapshotEntries[0]!.id;
    const candidates = [
      {
        content: "Анна работает из дома по вторникам.",
        evidenceKind: "firsthand" as const,
        kind: "fact" as const,
        primarySnapshotEntryId: primary,
        sensitivity: "normal" as const,
        supportingSnapshotEntryIds: [] as string[],
      },
      {
        content: "Анна предпочитает планировать встречи на другие дни.",
        evidenceKind: "inferred" as const,
        kind: "preference" as const,
        primarySnapshotEntryId: primary,
        sensitivity: "normal" as const,
        supportingSnapshotEntryIds: [] as string[],
      },
    ];
    const completed = await memoryExtractionRepository.complete({
      decisions: candidates.map((candidate) => ({ ...candidate, action: "save" as const })),
      diagnosticCode: "AGENT_MEMORY_EXTRACTION_PARTIAL_VALIDATED",
      jobId: job!.id,
      leaseToken: job!.leaseToken,
      partialResults: true,
    });
    const replayed = await memoryExtractionRepository.complete({
      decisions: candidates.map((candidate) => ({ ...candidate, action: "save" as const })),
      diagnosticCode: "AGENT_MEMORY_EXTRACTION_PARTIAL_VALIDATED",
      jobId: job!.id,
      leaseToken: job!.leaseToken,
      partialResults: true,
    });

    expect(completed.status).toBe("completed");
    expect(completed.candidates).toHaveLength(2);
    expect(new Set(completed.candidates.map((candidate) => candidate.candidateId)).size).toBe(2);
    expect(replayed).toEqual(completed);
    await expect(
      memoryExtractionRepository.eraseTerminalSnapshot(batch.id),
    ).rejects.toThrowError(/AGENT_MEMORY_EXTRACTION_ERASURE_UNSAFE/u);
    await expect(memoryExtractionRepository.rejectPendingCandidates(
      batch.id,
      "AGENT_MEMORY_EXTRACTION_CANDIDATES_REJECTED_BY_OPERATOR",
    )).resolves.toBe(2);
    await expect(memoryExtractionRepository.eraseTerminalSnapshot(batch.id)).resolves.toBe(true);
    await expect(
      memoryExtractionRepository.requeue(batch.id, "new_attempt"),
    ).rejects.toThrowError(/AGENT_MEMORY_EXTRACTION_SNAPSHOT_ERASED/u);
  });

  it("records empty completion and keeps range state independent", async () => {
    const fixture = await createFixture("702");
    const batch = await memoryExtractionRepository.createBatch({
      applicationSessionId: null,
      callerTelegramUserId: null,
      conversationId: fixture.conversationId,
      extractorVersion: "extractor-test-v1",
      firstSequence: "1",
      lastSequence: "2",
      omittedBeforeSequence: "0",
      schemaVersion: "memory-candidate-v1",
      timelineEntryIds: fixture.entryIds,
      turnId: "turn-empty-702",
    });
    const job = await memoryExtractionRepository.claimPending();
    await memoryExtractionRepository.markProviderCallStarted(job!.id, job!.leaseToken);
    const result = await memoryExtractionRepository.complete({
      decisions: [],
      diagnosticCode: null,
      jobId: job!.id,
      leaseToken: job!.leaseToken,
      partialResults: false,
    });
    const range = await memoryExtractionRepository.getRange(batch.id);

    expect(result.status).toBe("completed_empty");
    expect(range).toMatchObject({
      firstSequence: "1",
      lastSequence: "2",
      omittedBeforeSequence: "0",
      status: "completed_empty",
    });
  });

  it("replays one version exactly and isolates batches and source refs across versions", async () => {
    const fixture = await createFixture("704");
    const baseInput = {
      applicationSessionId: null,
      callerTelegramUserId: null,
      conversationId: fixture.conversationId,
      firstSequence: "1",
      lastSequence: "2",
      omittedBeforeSequence: null,
      timelineEntryIds: fixture.entryIds,
      turnId: "turn-versioned-704",
    };

    // Each reviewed extractor/schema pair owns an independent batch and exact coverage identity.
    const first = await memoryExtractionRepository.createBatch({
      ...baseInput,
      extractorVersion: "extractor-test-v1",
      schemaVersion: "memory-candidate-v1",
    });
    const replayed = await memoryExtractionRepository.createBatch({
      ...baseInput,
      extractorVersion: "extractor-test-v1",
      schemaVersion: "memory-candidate-v1",
    });
    const extractorRevision = await memoryExtractionRepository.createBatch({
      ...baseInput,
      extractorVersion: "extractor-test-v2",
      schemaVersion: "memory-candidate-v1",
    });
    const schemaRevision = await memoryExtractionRepository.createBatch({
      ...baseInput,
      extractorVersion: "extractor-test-v1",
      schemaVersion: "memory-candidate-v2",
    });

    expect(replayed).toEqual(first);
    expect(new Set([first.id, extractorRevision.id, schemaRevision.id]).size).toBe(3);
    expect(new Set([
      ...first.snapshotEntries.map((entry) => entry.sourceRef),
      ...extractorRevision.snapshotEntries.map((entry) => entry.sourceRef),
      ...schemaRevision.snapshotEntries.map((entry) => entry.sourceRef),
    ]).size).toBe(6);
    await expect(database().query(
      "SELECT 1 FROM memory_extraction_entry_coverage WHERE conversation_id = $1",
      [fixture.conversationId],
    )).resolves.toMatchObject({ rowCount: 6 });
  });

  it("never auto-retries failed work and requires explicit bounded requeue", async () => {
    const firstFixture = await createFixture("703");
    const firstBatch = await memoryExtractionRepository.createBatch({
      applicationSessionId: null,
      callerTelegramUserId: null,
      conversationId: firstFixture.conversationId,
      extractorVersion: "extractor-test-v1",
      firstSequence: "1",
      lastSequence: "2",
      omittedBeforeSequence: null,
      schemaVersion: "memory-candidate-v1",
      timelineEntryIds: firstFixture.entryIds,
      turnId: "turn-fail-703",
    });
    const firstJob = await memoryExtractionRepository.claimPending();
    await memoryExtractionRepository.fail(
      firstJob!.id,
      firstJob!.leaseToken,
      "AGENT_MEMORY_EXTRACTION_PROVIDER_FAILED",
    );
    await expect(memoryExtractionRepository.claimPending()).resolves.toBeNull();

    const safelyReset = await memoryExtractionRepository.requeue(firstBatch.id, "safe_reset");
    expect(safelyReset.attempt).toBe(1);
    const resetLease = await memoryExtractionRepository.claimPending();
    await memoryExtractionRepository.markProviderCallStarted(resetLease!.id, resetLease!.leaseToken);
    await memoryExtractionRepository.fail(
      resetLease!.id,
      resetLease!.leaseToken,
      "AGENT_MEMORY_EXTRACTION_OUTPUT_INVALID",
    );
    await expect(
      memoryExtractionRepository.requeue(firstBatch.id, "safe_reset"),
    ).rejects.toThrowError(/AGENT_MEMORY_EXTRACTION_REQUEUE_UNSAFE/u);

    const secondAttempt = await memoryExtractionRepository.requeue(firstBatch.id, "new_attempt");
    expect(secondAttempt.attempt).toBe(2);
  });
});
