/**
 * Memory reliability barriers across timeline retention and consolidation recovery.
 *
 * Constructs covered:
 * - Timeline entries remain held until an immutable extraction snapshot owns them.
 * - Catch-up records a durable diagnostic for a historical sequence that is already unavailable.
 * - A completed consolidation decision is consumed without staging a duplicate provider attempt.
 * - One terminal candidate cannot erase plaintext while a sibling needs resolution recovery.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { conversationRepository } from "./conversation-repository.js";
import { closeDatabase, database } from "./database.js";
import { createCatchUpExtractionBatches } from "./memory-extraction-batch-coordinator.js";
import { memoryExtractionRepository } from "./memory-extraction-repository.js";
import { recordTerminalExtractionEntries } from "./memory-extraction-progress-repository.js";
import { memoryConsolidationJobRepository } from "./memory-consolidation-job-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

async function fixture(suffix: string) {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ($1) RETURNING id",
    [`Reliability ${suffix}`],
  );
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, $2, $3, 'external', 'addressed_only') RETURNING id`,
    [family.rows[0]!.id, `-10088${suffix}`, `Reliability ${suffix}`],
  );
  const conversation = await conversationRepository.getByGroupId(group.rows[0]!.id);
  return { conversationId: conversation.id, familyId: family.rows[0]!.id, groupId: group.rows[0]!.id };
}

async function entry(input: {
  content: string;
  groupId: string;
  messageId: number;
  sequence: number;
}) {
  const result = await database().query<{ id: string }>(
    `INSERT INTO telegram_group_messages
       (group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
     VALUES ($1, $2, $3, 'user', 'telegram:8801', '8801', 'Анна', false, 'text', $4, now())
     RETURNING id`,
    [input.groupId, input.messageId, input.sequence, input.content],
  );
  return result.rows[0]!.id;
}

describeWithDatabase("memory reliability barriers", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE memory_thread_brief_jobs, telegram_final_deliveries,
         memory_extraction_batches, claim_evidence, memory_items,
         telegram_group_messages, telegram_groups, family_memberships, users, families CASCADE`,
    );
  });

  afterAll(closeDatabase);

  it("holds timeline plaintext until the exact snapshot commits", async () => {
    const current = await fixture("01");
    const entryId = await entry({ content: "Устойчивый факт", groupId: current.groupId, messageId: 1, sequence: 1 });

    await expect(database().query(
      "SELECT 1 FROM memory_extraction_retention_holds WHERE timeline_entry_id = $1",
      [entryId],
    )).resolves.toMatchObject({ rowCount: 1 });

    await memoryExtractionRepository.createBatch({
      applicationSessionId: null,
      callerTelegramUserId: null,
      conversationId: current.conversationId,
      extractorVersion: "semantic-extractor-v1",
      firstSequence: "1",
      lastSequence: "1",
      omittedBeforeSequence: null,
      schemaVersion: "memory-candidate-v2",
      timelineEntryIds: [entryId],
      turnId: "hold-release-1",
    });

    await expect(database().query(
      "SELECT 1 FROM memory_extraction_retention_holds WHERE timeline_entry_id = $1",
      [entryId],
    )).resolves.toMatchObject({ rowCount: 0 });
  });

  it("records and advances across an explicit pruned gap without claiming coverage", async () => {
    const current = await fixture("02");
    const first = await entry({ content: "Уже потеряно", groupId: current.groupId, messageId: 1, sequence: 1 });
    const second = await entry({ content: "Сохранилось", groupId: current.groupId, messageId: 2, sequence: 2 });
    await memoryExtractionRepository.createBatch({
      applicationSessionId: null,
      callerTelegramUserId: null,
      conversationId: current.conversationId,
      extractorVersion: "semantic-extractor-v1",
      firstSequence: "2",
      lastSequence: "2",
      omittedBeforeSequence: "1",
      schemaVersion: "memory-candidate-v2",
      timelineEntryIds: [second],
      turnId: "gap-covered-suffix",
    });
    await database().query("DELETE FROM memory_extraction_retention_holds WHERE timeline_entry_id = $1", [first]);
    await database().query("DELETE FROM telegram_group_messages WHERE id = $1", [first]);
    await database().query(
      "UPDATE application_conversations SET next_timeline_sequence = 2 WHERE id = $1",
      [current.conversationId],
    );

    await createCatchUpExtractionBatches();

    await expect(database().query(
      `SELECT first_sequence::text, last_sequence::text, diagnostic_code
       FROM memory_extraction_gaps WHERE conversation_id = $1`,
      [current.conversationId],
    )).resolves.toMatchObject({ rows: [{
      diagnostic_code: "AGENT_MEMORY_EXTRACTION_TIMELINE_GAP",
      first_sequence: "1",
      last_sequence: "1",
    }] });
    await expect(database().query(
      `SELECT last_contiguous_sequence::text
       FROM conversation_extraction_cursors WHERE conversation_id = $1`,
      [current.conversationId],
    )).resolves.toMatchObject({ rows: [{ last_contiguous_sequence: "2" }] });
  });

  it("terminally gaps one oversized entry and continues with later bounded plaintext", async () => {
    const current = await fixture("04");
    const oversized = await entry({
      content: "x".repeat(12_001), groupId: current.groupId, messageId: 1, sequence: 1,
    });
    const bounded = await entry({
      content: "Следующий полезный факт", groupId: current.groupId, messageId: 2, sequence: 2,
    });

    await expect(createCatchUpExtractionBatches()).resolves.toBe(0);
    await expect(database().query(
      `SELECT first_sequence::text, last_sequence::text, diagnostic_code
       FROM memory_extraction_gaps WHERE conversation_id = $1`,
      [current.conversationId],
    )).resolves.toMatchObject({ rows: [{
      diagnostic_code: "AGENT_MEMORY_EXTRACTION_ENTRY_TOO_LARGE",
      first_sequence: "1",
      last_sequence: "1",
    }] });
    await expect(database().query(
      "SELECT 1 FROM memory_extraction_retention_holds WHERE timeline_entry_id = $1",
      [oversized],
    )).resolves.toMatchObject({ rowCount: 0 });

    await expect(createCatchUpExtractionBatches()).resolves.toBe(1);
    await expect(database().query(
      "SELECT timeline_entry_id_snapshot FROM memory_extraction_entry_coverage WHERE conversation_id = $1",
      [current.conversationId],
    )).resolves.toMatchObject({ rows: [{ timeline_entry_id_snapshot: bounded }] });
    await expect(database().query(
      "SELECT last_contiguous_sequence::text FROM conversation_extraction_cursors WHERE conversation_id = $1",
      [current.conversationId],
    )).resolves.toMatchObject({ rows: [{ last_contiguous_sequence: "2" }] });
  });

  it("does not terminally gap or release an entry concurrently covered by a snapshot", async () => {
    const current = await fixture("05");
    const entryId = await entry({
      content: "Уже покрытый факт", groupId: current.groupId, messageId: 1, sequence: 1,
    });
    await memoryExtractionRepository.createBatch({
      applicationSessionId: null,
      callerTelegramUserId: null,
      conversationId: current.conversationId,
      extractorVersion: "semantic-extractor-v1",
      firstSequence: "1",
      lastSequence: "1",
      omittedBeforeSequence: null,
      schemaVersion: "memory-candidate-v2",
      timelineEntryIds: [entryId],
      turnId: "covered-before-terminal-rejection",
    });

    await recordTerminalExtractionEntries(
      current.conversationId,
      [{ id: entryId, sequenceId: "1" }],
      "AGENT_MEMORY_EXTRACTION_ENTRY_TOO_LARGE",
    );

    await expect(database().query(
      "SELECT 1 FROM memory_extraction_gaps WHERE conversation_id = $1",
      [current.conversationId],
    )).resolves.toMatchObject({ rowCount: 0 });
    await expect(database().query(
      "SELECT 1 FROM memory_extraction_entry_coverage WHERE timeline_entry_id_snapshot = $1",
      [entryId],
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it("reuses a completed consolidation decision instead of inserting attempt one again", async () => {
    const current = await fixture("03");
    const sourceEntry = await entry({
      content: "Я люблю зелёный чай",
      groupId: current.groupId,
      messageId: 1,
      sequence: 1,
    });
    const batch = await memoryExtractionRepository.createBatch({
      applicationSessionId: null,
      callerTelegramUserId: null,
      conversationId: current.conversationId,
      extractorVersion: "semantic-extractor-v1",
      firstSequence: "1",
      lastSequence: "1",
      omittedBeforeSequence: null,
      schemaVersion: "memory-candidate-v2",
      timelineEntryIds: [sourceEntry],
      turnId: "consolidation-terminal",
    });
    const job = await memoryExtractionRepository.claimPending();
    await memoryExtractionRepository.markProviderCallStarted(job!.id, job!.leaseToken);
    await memoryExtractionRepository.complete({
      decisions: [{
        action: "save",
        content: "Анна любит зелёный чай.",
        evidenceKind: "firsthand",
        kind: "preference",
        primarySnapshotEntryId: batch.snapshotEntries[0]!.id,
        sensitivity: "normal",
        subjectParticipantRef: batch.snapshotEntries[0]!.participantRef!,
        supportingSnapshotEntryIds: [],
      }],
      diagnosticCode: null,
      jobId: job!.id,
      leaseToken: job!.leaseToken,
      partialResults: false,
    });
    const candidate = await database().query<{ id: string }>(
      "SELECT id FROM memory_extraction_candidates WHERE batch_id = $1",
      [batch.id],
    );
    const identity = await database().query<{ id: string }>(
      "SELECT author_participant_id AS id FROM memory_extraction_snapshot_entries WHERE batch_id = $1",
      [batch.id],
    );
    await database().query(
      `INSERT INTO memory_items
         (family_id, group_id, author_telegram_user_id, scope, kind, content, source,
          confirmation, sensitivity, operation_key, origin_conversation_id,
          subject_participant_id, subject_conversation_id, content_normalized)
       VALUES ($1, $2, '8801', 'group', 'preference', 'Анна любит чай.', 'test:existing',
               'model_high', 'normal', 'existing-near', $3, $4, $3, 'анна любит чай.')`,
      [current.familyId, current.groupId, current.conversationId, identity.rows[0]!.id],
    );
    await database().query(
      `UPDATE memory_extraction_candidates
       SET resolution_status = 'resolution_processing', resolution_attempts = 1,
           resolution_lease_token = gen_random_uuid(),
           resolution_lease_expires_at = now() + interval '1 minute'
       WHERE id = $1`,
      [candidate.rows[0]!.id],
    );

    await expect(memoryConsolidationJobRepository.stageCandidate(candidate.rows[0]!.id))
      .resolves.toBe("pending");
    await database().query(
      `UPDATE memory_consolidation_jobs
       SET status = 'new', output_payload_hash = repeat('a', 64), completed_at = now()
       WHERE candidate_row_id = $1`,
      [candidate.rows[0]!.id],
    );
    await database().query(
      `UPDATE memory_extraction_candidates
       SET resolution_status = 'resolution_processing',
           resolution_lease_token = gen_random_uuid(),
           resolution_lease_expires_at = now() + interval '1 minute'
       WHERE id = $1`,
      [candidate.rows[0]!.id],
    );

    await expect(memoryConsolidationJobRepository.stageCandidate(candidate.rows[0]!.id))
      .resolves.toBe("ready");
    await expect(database().query(
      "SELECT count(*)::integer AS count FROM memory_consolidation_jobs WHERE candidate_row_id = $1",
      [candidate.rows[0]!.id],
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("keeps the whole snapshot while a sibling candidate is resolution_failed", async () => {
    const current = await fixture("06");
    const sourceEntry = await entry({
      content: "Анна любит чай и работает дома",
      groupId: current.groupId,
      messageId: 1,
      sequence: 1,
    });
    const batch = await memoryExtractionRepository.createBatch({
      applicationSessionId: null,
      callerTelegramUserId: null,
      conversationId: current.conversationId,
      extractorVersion: "semantic-extractor-v1",
      firstSequence: "1",
      lastSequence: "1",
      omittedBeforeSequence: null,
      schemaVersion: "memory-candidate-v2",
      timelineEntryIds: [sourceEntry],
      turnId: "candidate-plaintext-barrier",
    });
    const job = await memoryExtractionRepository.claimPending();
    await memoryExtractionRepository.markProviderCallStarted(job!.id, job!.leaseToken);
    const source = batch.snapshotEntries[0]!;
    await memoryExtractionRepository.complete({
      decisions: [{
        action: "save",
        content: "Анна любит чай.",
        evidenceKind: "firsthand",
        kind: "preference",
        primarySnapshotEntryId: source.id,
        sensitivity: "normal",
        subjectParticipantRef: source.participantRef!,
        supportingSnapshotEntryIds: [],
      }, {
        action: "save",
        content: "Анна работает дома.",
        evidenceKind: "firsthand",
        kind: "fact",
        primarySnapshotEntryId: source.id,
        sensitivity: "normal",
        subjectParticipantRef: source.participantRef!,
        supportingSnapshotEntryIds: [],
      }],
      diagnosticCode: null,
      jobId: job!.id,
      leaseToken: job!.leaseToken,
      partialResults: false,
    });
    const candidates = await database().query<{ id: string }>(
      "SELECT id FROM memory_extraction_candidates WHERE batch_id = $1 ORDER BY content",
      [batch.id],
    );
    await database().query(
      `UPDATE memory_extraction_candidates
       SET resolution_status = 'resolution_failed',
           resolution_diagnostic_code = 'AGENT_MEMORY_CANDIDATE_RESOLUTION_FAILED',
           resolved_at = now()
       WHERE id = $1`,
      [candidates.rows[0]!.id],
    );
    await database().query(
      `UPDATE memory_extraction_candidates
       SET resolution_status = 'rejected',
           resolution_diagnostic_code = 'AGENT_MEMORY_CANDIDATE_REJECTED',
           resolved_at = now()
       WHERE id = $1`,
      [candidates.rows[1]!.id],
    );

    await expect(database().query(
      `SELECT batch.snapshot_erased_at, snapshot.content_text,
              count(candidate.content)::integer AS candidate_plaintexts
       FROM memory_extraction_batches AS batch
       JOIN memory_extraction_snapshot_entries AS snapshot ON snapshot.batch_id = batch.id
       JOIN memory_extraction_candidates AS candidate ON candidate.batch_id = batch.id
       WHERE batch.id = $1
       GROUP BY batch.snapshot_erased_at, snapshot.content_text`,
      [batch.id],
    )).resolves.toMatchObject({ rows: [{
      candidate_plaintexts: 2,
      content_text: "Анна любит чай и работает дома",
      snapshot_erased_at: null,
    }] });
  });
});
