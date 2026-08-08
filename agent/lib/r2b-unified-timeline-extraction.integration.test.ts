/**
 * R2b unified timeline and automatic extraction integration tests.
 *
 * Constructs covered:
 * - Personal/group timeline isolation, private retention, aliases, and delivered agent responses.
 * - Exact visible coverage plus bounded catch-up of gaps without duplicate ranges.
 * - Source-author attribution, personal-only extraction, approval pending, secret rejection, reinforcement.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { conversationRepository } from "./conversation-repository.js";
import { conversationTimelineRepository } from "./conversation-timeline-repository.js";
import { closeDatabase, database } from "./database.js";
import {
  createCatchUpExtractionBatches,
  createTurnExtractionBatch,
} from "./memory-extraction-batch-coordinator.js";
import { processMemoryExtractionCandidates } from "./memory-extraction-candidate-processor.js";
import { memoryApprovalNoticeRepository } from "./memory-approval-notice-repository.js";
import { memoryExtractionRepository } from "./memory-extraction-repository.js";
import { memorySensitiveApprovalRepository } from "./memory-sensitive-approval-repository.js";
import { telegramFinalDeliveryRepository } from "./telegram-final-delivery-repository.js";
import {
  completeExtractionBatch as completeBatch,
  createExtractionFamily as createFamily,
  createExtractionGroup as createGroup,
  createExtractionMember as createMember,
  insertExtractionEntry as insertEntry,
  telegramTestMessage as message,
} from "./r2b-unified-timeline-extraction-fixtures.js";
import { sessionRepository } from "./sessions/session-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

describeWithDatabase("R2b unified timeline and extraction", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE telegram_final_deliveries, memory_extraction_batches, claim_evidence, memory_items,
         telegram_group_messages, telegram_groups, family_memberships, users, families CASCADE`,
    );
  });

  afterAll(closeDatabase);

  it("isolates personal timelines and retains exactly 1000 logical entries", async () => {
    const familyId = await createFamily("Private timeline");
    await createMember({ familyId, name: "Анна", role: "owner", telegramUserId: "7101" });
    const personal = await conversationRepository.getByChatId("7101");
    expect(personal.scope).toBe("personal");
    expect(await database().query(
      "SELECT 1 FROM telegram_group_messages WHERE conversation_id = $1",
      [personal.id],
    )).toHaveProperty("rowCount", 0);

    await database().query(
      `INSERT INTO telegram_group_messages
         (conversation_id, telegram_message_id, sequence_id, actor_kind, actor_id,
          telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
       SELECT $1, value, value, 'user', 'telegram:7101', '7101', 'Анна', false,
              'text', 'private-' || value::text, now()
       FROM generate_series(1, 1000) AS value`,
      [personal.id],
    );
    // The seed represents rows already owned by extraction snapshots; only new rows need holds.
    await database().query(
      "DELETE FROM memory_extraction_retention_holds WHERE conversation_id = $1",
      [personal.id],
    );
    const inbound = await conversationTimelineRepository.recordInbound(
      personal.id,
      message({ chatId: "7101", messageId: "1001", text: "private-1001", userId: "7101", userName: "Анна" }),
    );
    await conversationTimelineRepository.recordAgentResponse({
      applicationSessionId: null,
      contentText: "Доставленный личный ответ",
      conversationId: personal.id,
      deliveredAt: new Date(),
      messageThreadId: null,
      replyToEntryId: inbound.entryId,
      telegramMessageIds: ["2001", "2002"],
    });
    const retained = await database().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM telegram_group_messages WHERE conversation_id = $1",
      [personal.id],
    );
    const aliases = await database().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM telegram_group_message_ids WHERE conversation_id = $1 AND telegram_message_id IN (2001, 2002)",
      [personal.id],
    );
    expect(retained.rows[0]!.count).toBe("1000");
    expect(aliases.rows[0]!.count).toBe("2");
    expect((await conversationTimelineRepository.listRecent({
      beforeSequence: "1003",
      conversationId: personal.id,
      limit: 49,
    })).every((entry) => entry.telegramUserId === "7101" || entry.actorKind === "agent_self")).toBe(true);
  });

  it("covers the exact visible batch and catches up an older gap without overlap", async () => {
    const familyId = await createFamily("Catch up");
    const groupId = await createGroup({ familyId, idSuffix: "7201", type: "external" });
    const entryIds = [
      await insertEntry({ content: "Первая запись", groupId, messageId: 1, sequence: 1, telegramUserId: "1", userName: "Анна" }),
      await insertEntry({ content: "Вторая запись", groupId, messageId: 2, sequence: 2, telegramUserId: "2", userName: "Пётр" }),
      await insertEntry({ content: "Видимая запись", groupId, messageId: 3, sequence: 3, telegramUserId: "1", userName: "Анна" }),
    ];
    const conversation = await conversationRepository.getByGroupId(groupId);
    const visible = await memoryExtractionRepository.createBatch({
      applicationSessionId: null,
      callerTelegramUserId: null,
      conversationId: conversation.id,
      extractorVersion: "semantic-extractor-v1",
      firstSequence: "3",
      lastSequence: "3",
      omittedBeforeSequence: "2",
      schemaVersion: "memory-candidate-v2",
      timelineEntryIds: [entryIds[2]!],
      turnId: "visible-turn",
    });
    expect(visible.snapshotEntries.map((entry) => entry.sequenceId)).toEqual(["3"]);

    await expect(createCatchUpExtractionBatches()).resolves.toBe(1);
    const coverage = await database().query<{ sequence: string }>(
      `SELECT timeline_sequence::text AS sequence FROM memory_extraction_entry_coverage
       WHERE conversation_id = $1 ORDER BY timeline_sequence`,
      [conversation.id],
    );
    expect(coverage.rows.map((row) => row.sequence)).toEqual(["1", "2", "3"]);
    await expect(createCatchUpExtractionBatches()).resolves.toBe(0);
  });

  it("keeps catch-up ranges and snapshots in numeric sequence order", async () => {
    const familyId = await createFamily("Numeric catch-up order");
    const groupId = await createGroup({ familyId, idSuffix: "7204", type: "external" });
    await insertEntry({ content: "Девятая запись", groupId, messageId: 9, sequence: 9, telegramUserId: "1", userName: "Анна" });
    await insertEntry({ content: "Десятая запись", groupId, messageId: 10, sequence: 10, telegramUserId: "1", userName: "Анна" });

    await expect(createCatchUpExtractionBatches()).resolves.toBe(1);

    // PostgreSQL output aliases must not turn bigint ordering into lexicographic text ordering.
    const range = await database().query<{ first: string; last: string }>(
      `SELECT first_sequence::text AS first, last_sequence::text AS last
       FROM memory_extraction_ranges`,
    );
    const snapshots = await database().query<{ sequence: string }>(
      `SELECT sequence_id::text AS sequence FROM memory_extraction_snapshot_entries
       ORDER BY ordinal`,
    );
    expect(range.rows).toEqual([{ first: "9", last: "10" }]);
    expect(snapshots.rows.map((row) => row.sequence)).toEqual(["9", "10"]);
  });

  it("treats catch-up-first coverage as a completed turn race without duplicating entries", async () => {
    const familyId = await createFamily("Catch-up race");
    const groupId = await createGroup({ familyId, idSuffix: "7202", type: "external" });
    const entryIds = [
      await insertEntry({ content: "Первая запись", groupId, messageId: 1, sequence: 1, telegramUserId: "1", userName: "Анна" }),
      await insertEntry({ content: "Вторая запись", groupId, messageId: 2, sequence: 2, telegramUserId: "2", userName: "Пётр" }),
    ];
    const conversation = await conversationRepository.getByGroupId(groupId);
    const session = await sessionRepository.prepareTurn({
      baseContinuationToken: `catch-up-race:${groupId}`,
      familyId,
      groupId,
      kind: "canonical",
      now: new Date(),
      scope: "group",
      telegramForumTopicId: null,
      userId: null,
    });

    // A background pass may win before Eve emits turn.completed; the turn must not fail or pay twice.
    await expect(createCatchUpExtractionBatches()).resolves.toBe(1);
    await expect(createTurnExtractionBatch({
      applicationSessionId: session.id,
      callerTelegramUserId: "2",
      conversationId: conversation.id,
      entryIds,
      eveSessionId: "wrun_catch_up_race",
      omittedBeforeSequence: null,
      turnId: "catch-up-first-turn",
    })).resolves.toBeNull();
    await expect(database().query(
      `SELECT count(*)::integer AS count,
              count(DISTINCT timeline_entry_id_snapshot)::integer AS distinct_count
       FROM memory_extraction_entry_coverage WHERE conversation_id = $1`,
      [conversation.id],
    )).resolves.toMatchObject({ rows: [{ count: 2, distinct_count: 2 }] });
  });

  it("creates a turn batch only for entries left uncovered by a concurrent range", async () => {
    const familyId = await createFamily("Partial coverage race");
    const groupId = await createGroup({ familyId, idSuffix: "7203", type: "external" });
    const entryIds = [
      await insertEntry({ content: "Уже покрыта", groupId, messageId: 1, sequence: 1, telegramUserId: "1", userName: "Анна" }),
      await insertEntry({ content: "Ещё не покрыта", groupId, messageId: 2, sequence: 2, telegramUserId: "2", userName: "Пётр" }),
    ];
    const conversation = await conversationRepository.getByGroupId(groupId);
    const session = await sessionRepository.prepareTurn({
      baseContinuationToken: `partial-race:${groupId}`,
      familyId,
      groupId,
      kind: "canonical",
      now: new Date(),
      scope: "group",
      telegramForumTopicId: null,
      userId: null,
    });
    await memoryExtractionRepository.createBatch({
      applicationSessionId: null,
      callerTelegramUserId: null,
      conversationId: conversation.id,
      extractorVersion: "semantic-extractor-v1",
      firstSequence: "1",
      lastSequence: "1",
      omittedBeforeSequence: null,
      schemaVersion: "memory-candidate-v2",
      timelineEntryIds: [entryIds[0]!],
      turnId: "concurrent-prefix",
    });

    const turnBatch = await createTurnExtractionBatch({
      applicationSessionId: session.id,
      callerTelegramUserId: "2",
      conversationId: conversation.id,
      entryIds,
      eveSessionId: "wrun_partial_race",
      omittedBeforeSequence: null,
      turnId: "partial-race-turn",
    });
    expect(turnBatch?.snapshotEntries.map((entry) => entry.sequenceId)).toEqual(["2"]);
    await expect(createTurnExtractionBatch({
      applicationSessionId: session.id,
      callerTelegramUserId: "2",
      conversationId: conversation.id,
      entryIds,
      eveSessionId: "wrun_partial_race",
      omittedBeforeSequence: null,
      turnId: "partial-race-turn",
    })).resolves.toEqual(turnBatch);
    await expect(database().query(
      "SELECT 1 FROM memory_extraction_entry_coverage WHERE conversation_id = $1",
      [conversation.id],
    )).resolves.toMatchObject({ rowCount: 2 });
  });

  it("isolates repeated Eve turn ids by Eve session", async () => {
    const familyId = await createFamily("Eve turn identity");
    const groupId = await createGroup({ familyId, idSuffix: "7205", type: "external" });
    const entryIds = [
      await insertEntry({ content: "Первая сессия", groupId, messageId: 1, sequence: 1, telegramUserId: "1", userName: "Анна" }),
      await insertEntry({ content: "Вторая сессия", groupId, messageId: 2, sequence: 2, telegramUserId: "2", userName: "Пётр" }),
    ];
    const conversation = await conversationRepository.getByGroupId(groupId);
    const session = await sessionRepository.prepareTurn({
      baseContinuationToken: `eve-turn-identity:${groupId}`,
      familyId,
      groupId,
      kind: "canonical",
      now: new Date(),
      scope: "group",
      telegramForumTopicId: null,
      userId: null,
    });

    // Eve turn ids restart from zero in each framework session and must not collide durably.
    await expect(createTurnExtractionBatch({
      applicationSessionId: session.id,
      callerTelegramUserId: "1",
      conversationId: conversation.id,
      entryIds: [entryIds[0]!],
      eveSessionId: "wrun_extraction_a",
      omittedBeforeSequence: null,
      turnId: "turn_0",
    })).resolves.not.toBeNull();
    await expect(createTurnExtractionBatch({
      applicationSessionId: session.id,
      callerTelegramUserId: "2",
      conversationId: conversation.id,
      entryIds: [entryIds[1]!],
      eveSessionId: "wrun_extraction_b",
      omittedBeforeSequence: null,
      turnId: "turn_0",
    })).resolves.not.toBeNull();

    await expect(database().query<{ eve_session_id: string }>(
      `SELECT eve_session_id FROM memory_extraction_batches
       WHERE conversation_id = $1 ORDER BY eve_session_id`,
      [conversation.id],
    )).resolves.toMatchObject({
      rows: [
        { eve_session_id: "wrun_extraction_a" },
        { eve_session_id: "wrun_extraction_b" },
      ],
    });

    // The same framework identity also scopes Telegram's no-resend barrier between conversations.
    const firstDelivery = await telegramFinalDeliveryRepository.start({
      applicationSessionId: session.id,
      chunkCount: 1,
      eveSessionId: "wrun_delivery_a",
      eveTurnId: "turn_0",
      outputHash: "a".repeat(64),
    });
    const secondDelivery = await telegramFinalDeliveryRepository.start({
      applicationSessionId: session.id,
      chunkCount: 1,
      eveSessionId: "wrun_delivery_b",
      eveTurnId: "turn_0",
      outputHash: "b".repeat(64),
    });
    expect(firstDelivery.status).toBe("started");
    expect(secondDelivery.status).toBe("started");
    await expect(database().query<{ eve_session_id: string }>(
      `SELECT eve_session_id FROM telegram_final_deliveries
       WHERE eve_turn_id = 'turn_0' ORDER BY eve_session_id`,
    )).resolves.toMatchObject({
      rows: [
        { eve_session_id: "wrun_delivery_a" },
        { eve_session_id: "wrun_delivery_b" },
      ],
    });
  });

  it("attributes Anna when Petr triggers and keeps private extraction personal", async () => {
    const familyId = await createFamily("Attribution");
    const annaId = await createMember({ familyId, name: "Анна", role: "owner", telegramUserId: "7301" });
    const petrId = await createMember({ familyId, name: "Пётр", role: "member", telegramUserId: "7302" });
    const groupId = await createGroup({ familyId, idSuffix: "7300", type: "family_private" });
    const annaEntry = await insertEntry({
      content: "Я работаю дома по вторникам", groupId, messageId: 1, sequence: 1,
      telegramUserId: "7301", userName: "Анна",
    });
    const petrEntry = await insertEntry({
      content: "Осинара, что запомнила?", groupId, messageId: 2, sequence: 2,
      telegramUserId: "7302", userName: "Пётр",
    });
    const conversation = await conversationRepository.getByGroupId(groupId);
    const batch = await memoryExtractionRepository.createBatch({
      applicationSessionId: null, callerTelegramUserId: "7302", conversationId: conversation.id,
      extractorVersion: "test", firstSequence: "1", lastSequence: "2",
      omittedBeforeSequence: null, schemaVersion: "test", timelineEntryIds: [annaEntry, petrEntry],
      turnId: "petr-trigger",
    });
    await completeBatch({
      action: "save", batchId: batch.id, content: "Анна работает дома по вторникам.",
      primarySnapshotEntryId: batch.snapshotEntries[0]!.id, sensitivity: "normal",
    });
    await processMemoryExtractionCandidates(batch.id);
    const familyClaim = await database().query<{ author_user_id: string; scope: string }>(
      "SELECT author_user_id, scope::text FROM memory_items WHERE content = $1",
      ["Анна работает дома по вторникам."],
    );
    expect(familyClaim.rows[0]).toEqual({ author_user_id: annaId, scope: "family" });
    const auditActor = await database().query<{ actor_user_id: string | null }>(
      `SELECT audit.actor_user_id FROM audit_events AS audit
       JOIN memory_items AS memory ON memory.id = audit.subject_id
       WHERE audit.event_type = 'memory.created' AND memory.content = $1`,
      ["Анна работает дома по вторникам."],
    );
    expect(auditActor.rows).toEqual([{ actor_user_id: petrId }]);

    const personal = await conversationRepository.getByChatId("7301");
    const privateEntry = (await conversationTimelineRepository.recordInbound(
      personal.id,
      message({ chatId: "7301", messageId: "10", text: "Я люблю улун", userId: "7301", userName: "Анна" }),
    )).entryId;
    const privateBatch = await memoryExtractionRepository.createBatch({
      applicationSessionId: null, callerTelegramUserId: "7301",
      conversationId: personal.id, extractorVersion: "test",
      firstSequence: "1", lastSequence: "1", omittedBeforeSequence: null, schemaVersion: "test",
      timelineEntryIds: [privateEntry], turnId: "private",
    });
    await completeBatch({
      action: "save", batchId: privateBatch.id, content: "Анна любит улун.",
      primarySnapshotEntryId: privateBatch.snapshotEntries[0]!.id, sensitivity: "normal",
    });
    await processMemoryExtractionCandidates(privateBatch.id);
    const privateClaim = await database().query<{ scope: string }>(
      "SELECT scope::text FROM memory_items WHERE content = 'Анна любит улун.'",
    );
    expect(privateClaim.rows).toEqual([{ scope: "personal" }]);
  });

  it("keeps sensitive pending, rejects secrets, and reinforces exact duplicates", async () => {
    const familyId = await createFamily("Policy");
    const groupId = await createGroup({ familyId, idSuffix: "7400", type: "external" });
    const conversation = await conversationRepository.getByGroupId(groupId);
    let sensitiveBatchId: string | null = null;
    const contents = ["Мне противопоказан аспирин", "Карта 4242 4242 4242 4242", "Я люблю улун", "я  люблю   улун"];
    for (const [index, content] of contents.entries()) {
      const sequence = index + 1;
      const entryId = await insertEntry({
        content, groupId, messageId: sequence, sequence, telegramUserId: "7401", userName: "Анна",
      });
      const batch = await memoryExtractionRepository.createBatch({
        applicationSessionId: null, callerTelegramUserId: "7401",
        conversationId: conversation.id, extractorVersion: "policy-test",
        firstSequence: String(sequence), lastSequence: String(sequence), omittedBeforeSequence: null,
        schemaVersion: "policy-test", timelineEntryIds: [entryId], turnId: `policy-${sequence}`,
      });
      if (index === 0) sensitiveBatchId = batch.id;
      const action = index === 0 ? "needs_approval" : "save";
      await completeBatch({
        action, batchId: batch.id,
        content: index >= 2 ? "Анна любит улун." : content,
        primarySnapshotEntryId: batch.snapshotEntries[0]!.id,
        sensitivity: index === 0 ? "sensitive" : "normal",
      });
      await processMemoryExtractionCandidates(batch.id);
    }
    const states = await database().query<{ resolution_status: string }>(
      "SELECT resolution_status FROM memory_extraction_candidates ORDER BY created_at",
    );
    expect(states.rows.map((row) => row.resolution_status)).toEqual([
      "approval_pending", "rejected", "claim_created", "reinforced",
    ]);
    expect((await database().query("SELECT 1 FROM memory_extraction_approval_notices WHERE status = 'pending'")).rowCount).toBe(1);
    expect((await database().query("SELECT 1 FROM memory_items WHERE content LIKE 'Карта%'")).rowCount).toBe(0);
    expect((await database().query("SELECT 1 FROM memory_items WHERE content = 'Анна любит улун.'")).rowCount).toBe(1);
    expect((await database().query("SELECT 1 FROM claim_evidence WHERE evidence_role = 'reinforcement'")).rowCount).toBe(1);
    expect((await database().query<{ reinforcement_count: number }>("SELECT reinforcement_count FROM memory_items WHERE content = 'Анна любит улун.'")).rows[0]?.reinforcement_count).toBe(1);
    const sourceAuth = {
      familyId,
      groupId,
      role: "external" as const,
      scopes: ["group" as const],
      telegramUserId: "7401",
      userId: null,
    };
    const firstNotice = await memoryApprovalNoticeRepository.pendingContext(sourceAuth, conversation.id);
    expect(firstNotice?.context).toMatch(/approval_[0-9a-f]{32}/u);
    await expect(memoryApprovalNoticeRepository.pendingContext(sourceAuth, conversation.id))
      .resolves.toBeNull();
    const approval = await database().query<{ approval_ref: string }>(
      "SELECT approval_ref FROM memory_extraction_approval_notices WHERE status = 'pending'",
    );
    const approvalRef = approval.rows[0]!.approval_ref;
    await expect(database().query(
      `SELECT candidate.content, snapshot.content_text, snapshot.erased_at
       FROM memory_extraction_candidates AS candidate
       JOIN memory_extraction_candidate_sources AS source ON source.candidate_row_id = candidate.id
       JOIN memory_extraction_snapshot_entries AS snapshot ON snapshot.id = source.snapshot_entry_id
       WHERE candidate.batch_id = $1 AND candidate.resolution_status = 'approval_pending'`,
      [sensitiveBatchId],
    )).resolves.toMatchObject({ rows: [expect.objectContaining({
      content: "Мне противопоказан аспирин",
      content_text: "Мне противопоказан аспирин",
      erased_at: null,
    })] });
    await expect(memorySensitiveApprovalRepository.resolve(
      { ...sourceAuth, telegramUserId: "7499" },
      { action: "approve", approvalRef, operationKey: "unauthorized-sensitive" },
    )).rejects.toThrowError(/AGENT_MEMORY_APPROVAL_DENIED/u);
    const approved = await memorySensitiveApprovalRepository.resolve(sourceAuth, {
      action: "approve",
      approvalRef,
      operationKey: "approve-sensitive",
    });
    await expect(memorySensitiveApprovalRepository.resolve(sourceAuth, {
      action: "approve",
      approvalRef,
      operationKey: "approve-sensitive",
    })).resolves.toEqual(approved);
    expect(approved).toMatchObject({ status: "approved", memoryRef: expect.stringMatching(/^mem_/u) });
    await expect(database().query(
      `SELECT confirmation::text, sensitivity::text, save_approved, provenance_state::text
       FROM memory_items WHERE content = 'Мне противопоказан аспирин'`,
    )).resolves.toMatchObject({ rows: [{
      confirmation: "user_confirmed",
      provenance_state: "evidenced",
      save_approved: true,
      sensitivity: "sensitive",
    }] });
    const rejectedEntry = await insertEntry({
      content: "Мой чувствительный факт", groupId, messageId: 10, sequence: 10,
      telegramUserId: "7401", userName: "Анна",
    });
    const rejectedBatch = await memoryExtractionRepository.createBatch({
      applicationSessionId: null, callerTelegramUserId: "7401",
      conversationId: conversation.id, extractorVersion: "policy-test",
      firstSequence: "10", lastSequence: "10", omittedBeforeSequence: null,
      schemaVersion: "policy-test", timelineEntryIds: [rejectedEntry], turnId: "policy-reject",
    });
    await completeBatch({
      action: "needs_approval", batchId: rejectedBatch.id, content: "Мой чувствительный факт",
      primarySnapshotEntryId: rejectedBatch.snapshotEntries[0]!.id, sensitivity: "sensitive",
    });
    await processMemoryExtractionCandidates(rejectedBatch.id);
    const rejectNotice = await database().query<{ approval_ref: string }>(
      `SELECT notice.approval_ref FROM memory_extraction_approval_notices AS notice
       JOIN memory_extraction_candidates AS candidate ON candidate.id = notice.candidate_row_id
       WHERE candidate.batch_id = $1`,
      [rejectedBatch.id],
    );
    const rejectRef = rejectNotice.rows[0]!.approval_ref;
    await expect(memorySensitiveApprovalRepository.resolve(sourceAuth, {
      action: "reject",
      approvalRef: rejectRef,
      operationKey: "reject-sensitive",
    })).resolves.toEqual({ status: "rejected" });
    await expect(memorySensitiveApprovalRepository.resolve(sourceAuth, {
      action: "approve",
      approvalRef: rejectRef,
      operationKey: "approve-after-reject",
    })).rejects.toThrowError(/AGENT_MEMORY_APPROVAL_DENIED/u);
    expect((await database().query(
      "SELECT 1 FROM memory_items WHERE content = 'Мой чувствительный факт'",
    )).rowCount).toBe(0);
    await expect(database().query(
      `SELECT candidate.content, candidate.content_erased_at,
              snapshot.content_text, snapshot.erased_at, batch.snapshot_erased_at
       FROM memory_extraction_candidates AS candidate
       JOIN memory_extraction_batches AS batch ON batch.id = candidate.batch_id
       JOIN memory_extraction_candidate_sources AS source ON source.candidate_row_id = candidate.id
       JOIN memory_extraction_snapshot_entries AS snapshot ON snapshot.id = source.snapshot_entry_id
       WHERE candidate.batch_id = $1`,
      [rejectedBatch.id],
    )).resolves.toMatchObject({ rows: [expect.objectContaining({
      content: null,
      content_erased_at: expect.any(Date),
      content_text: null,
      erased_at: expect.any(Date),
      snapshot_erased_at: expect.any(Date),
    })] });
  });
});
