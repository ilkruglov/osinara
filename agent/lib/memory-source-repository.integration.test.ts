/**
 * R3 projection-aware provenance lookup integration tests.
 *
 * Constructs covered:
 * - Personal lookup re-authorizes an opted-in external self projection by opaque memoryRef.
 * - Retained and pruned timeline states report availability honestly while preserving safe evidence.
 * - Model-safe output contains no raw database, Telegram chat/user/message, or sequence identifiers.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { conversationRepository } from "./conversation-repository.js";
import { closeDatabase, database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { processMemoryExtractionCandidates } from "./memory-extraction-candidate-processor.js";
import { memoryExtractionRepository } from "./memory-extraction-repository.js";
import { memorySourceRepository } from "./memory-source-repository.js";
import { profileProjectionPolicyRepository } from "./profile-projection-policy-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

describeWithDatabase("R3 memory source lookup", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE memory_extraction_batches, claim_evidence, memory_items,
         telegram_group_messages, telegram_groups, family_memberships, users, families CASCADE`,
    );
  });

  afterAll(closeDatabase);

  it("returns safe retained/pruned provenance only while the projection remains authorized", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Source lookup') RETURNING id",
    );
    const user = await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('9501', 'Анна') RETURNING id",
    );
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
      [family.rows[0]!.id, user.rows[0]!.id],
    );
    const group = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, '-1009501', 'Закрытый источник', 'external', 'addressed_only') RETURNING id`,
      [family.rows[0]!.id],
    );
    const entry = await database().query<{ id: string }>(
      `INSERT INTO telegram_group_messages
         (group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
          telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
       VALUES ($1, 777, 1, 'user', 'telegram:9501', '9501', 'Анна', false,
               'text', 'Я предпочитаю утренние встречи', now()) RETURNING id`,
      [group.rows[0]!.id],
    );
    const conversation = await conversationRepository.getByGroupId(group.rows[0]!.id);
    const batch = await memoryExtractionRepository.createBatch({
      applicationSessionId: null,
      callerTelegramUserId: "9501",
      conversationId: conversation.id,
      extractorVersion: "source-test",
      firstSequence: "1",
      lastSequence: "1",
      omittedBeforeSequence: null,
      schemaVersion: "source-test",
      timelineEntryIds: [entry.rows[0]!.id],
      turnId: "source-turn",
    });
    const job = await memoryExtractionRepository.claimPending();
    await memoryExtractionRepository.markProviderCallStarted(job!.id, job!.leaseToken);
    await memoryExtractionRepository.complete({
      decisions: [{
        action: "save",
        content: "Анна предпочитает утренние встречи.",
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
    await processMemoryExtractionCandidates(batch.id);
    const claim = await database().query<{ id: string; memory_ref: string }>(
      `SELECT claim.id, ref.memory_ref FROM memory_items AS claim
       JOIN memory_item_refs AS ref ON ref.memory_item_id = claim.id
       WHERE claim.content = 'Анна предпочитает утренние встречи.'`,
    );
    const memoryRef = claim.rows[0]!.memory_ref;
    const personalAuth: MemoryAuthorization = {
      familyId: family.rows[0]!.id,
      groupId: null,
      role: "owner",
      scopes: ["personal", "family"],
      telegramUserId: "9501",
      userId: user.rows[0]!.id,
    };
    await expect(memorySourceRepository.lookup(personalAuth, memoryRef))
      .rejects.toThrowError(/AGENT_MEMORY_SOURCE_NOT_FOUND/u);

    const policy = (await profileProjectionPolicyRepository.list(personalAuth))[0]!;
    await profileProjectionPolicyRepository.update(personalAuth, {
      enabled: true,
      groupRef: policy.groupRef,
      operationKey: "enable-source-lookup",
    });
    const notice = await profileProjectionPolicyRepository.claimPendingGroupNotice(group.rows[0]!.id);
    await profileProjectionPolicyRepository.markGroupNoticePresented({
      deliveryToken: notice!.deliveryToken,
      noticeRef: notice!.noticeRef,
    });
    const retained = await memorySourceRepository.lookup(personalAuth, memoryRef);
    expect(retained).toMatchObject({
      evidenceSnippet: "Я предпочитаю утренние встречи",
      fullTimelineSourceAvailable: true,
      originChatLabel: "Закрытый источник",
      sourceAuthorLabel: "Анна",
    });
    expect(JSON.stringify(retained)).not.toMatch(
      /-1009501|9501|777|groupId|sourceMessageId|timelineSequence|telegramUserId/u,
    );

    // The same shared projection predicate must reject inferred evidence through direct source lookup.
    await database().query(
      "UPDATE claim_evidence SET evidence_kind = 'inferred' WHERE claim_id = $1",
      [claim.rows[0]!.id],
    );
    await expect(memorySourceRepository.lookup(personalAuth, memoryRef))
      .rejects.toThrowError(/AGENT_MEMORY_SOURCE_NOT_FOUND/u);
    await database().query(
      "UPDATE claim_evidence SET evidence_kind = 'firsthand' WHERE claim_id = $1",
      [claim.rows[0]!.id],
    );

    await database().query("DELETE FROM telegram_group_messages WHERE id = $1", [entry.rows[0]!.id]);
    const pruned = await memorySourceRepository.lookup(personalAuth, memoryRef);
    expect(pruned).toMatchObject({
      evidenceSnippet: retained.evidenceSnippet,
      fullTimelineSourceAvailable: false,
    });
    expect(pruned).not.toHaveProperty("telegramLink");

    await profileProjectionPolicyRepository.update(personalAuth, {
      enabled: false,
      groupRef: policy.groupRef,
      operationKey: "disable-source-lookup",
    });
    await expect(memorySourceRepository.lookup(personalAuth, memoryRef))
      .rejects.toThrowError(/AGENT_MEMORY_SOURCE_NOT_FOUND/u);
  });
});
