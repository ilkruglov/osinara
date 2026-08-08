/**
 * Claim evidence and single-writer integration tests.
 *
 * Constructs covered:
 * - `memoryRepository.create` atomically derives claim provenance from one completed candidate.
 * - Source authors, scope, conversation, subject, and timeline coordinates come from PostgreSQL.
 * - Replays do not duplicate evidence and cross-group callers cannot consume a candidate.
 * - Ordinary remember-compatible writes remain honestly `legacy_unresolved` without invented evidence.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { claimEvidenceRepository } from "./claim-evidence-repository.js";
import { conversationRepository } from "./conversation-repository.js";
import { closeDatabase, database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { memoryExtractionRepository } from "./memory-extraction-repository.js";
import { memoryRepository } from "./memory-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

describeWithDatabase("claim evidence writer", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE memory_extraction_batches, claim_evidence, memory_items,
         telegram_group_messages, telegram_groups, family_memberships, users, families CASCADE`,
    );
  });

  afterAll(closeDatabase);

  it("creates one evidenced claim from verified primary and supporting snapshots", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Evidence family') RETURNING id",
    );
    const groups = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, '-100801', 'Источник', 'external', 'addressed_only'),
              ($1, '-100802', 'Чужая зона', 'external', 'addressed_only')
       RETURNING id`,
      [family.rows[0]!.id],
    );
    const entries = await database().query<{ id: string }>(
      `INSERT INTO telegram_group_messages
         (group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
          telegram_user_id, sender_display_name, sender_is_bot, message_kind,
          content_text, sent_at)
       VALUES ($1, 81, 1, 'user', 'telegram:811', '811', 'Мария', false, 'text',
               'Куда решили поехать?', now() - interval '1 minute'),
              ($1, 82, 2, 'user', 'telegram:812', '812', 'Пётр', false, 'text',
               'Летом едем в Казань', now())
       RETURNING id`,
      [groups.rows[0]!.id],
    );
    const conversation = await conversationRepository.getByGroupId(groups.rows[0]!.id);
    const batch = await memoryExtractionRepository.createBatch({
      applicationSessionId: null,
      callerTelegramUserId: null,
      conversationId: conversation.id,
      extractorVersion: "extractor-test-v1",
      firstSequence: "1",
      lastSequence: "2",
      omittedBeforeSequence: null,
      schemaVersion: "memory-candidate-v1",
      timelineEntryIds: entries.rows.map((row) => row.id),
      turnId: "turn-evidence-801",
    });
    const job = await memoryExtractionRepository.claimPending();
    await memoryExtractionRepository.markProviderCallStarted(job!.id, job!.leaseToken);
    const extraction = await memoryExtractionRepository.complete({
      decisions: [{
        action: "save",
        content: "Семья планирует поездку в Казань летом.",
        evidenceKind: "reported",
        kind: "episode",
        primarySnapshotEntryId: batch.snapshotEntries[1]!.id,
        sensitivity: "normal",
        subjectParticipantRef: batch.snapshotEntries[0]!.participantRef!,
        supportingSnapshotEntryIds: [batch.snapshotEntries[0]!.id],
      }],
      diagnosticCode: null,
      jobId: job!.id,
      leaseToken: job!.leaseToken,
      partialResults: false,
    });
    const candidate = extraction.candidates[0]!;
    await database().query(
      `UPDATE memory_extraction_candidates
       SET resolution_status = 'resolution_processing', resolution_attempts = 1,
           resolution_lease_token = gen_random_uuid(),
           resolution_lease_expires_at = now() + interval '1 minute'
       WHERE candidate_id = $1`,
      [candidate.candidateId],
    );
    const sourceAuth: MemoryAuthorization = {
      familyId: family.rows[0]!.id,
      groupId: groups.rows[0]!.id,
      role: "external",
      scopes: ["group"],
      telegramUserId: "turn-caller",
      userId: null,
    };
    const crossGroupAuth = { ...sourceAuth, groupId: groups.rows[1]!.id };
    const createInput = {
      confirmation: "model_high" as const,
      content: "Семья планирует поездку в Казань летом.",
      evidence: { extractionCandidateId: candidate.candidateId },
      kind: "episode" as const,
      operationKey: candidate.operationKey,
      scope: "group" as const,
      sensitivity: "normal" as const,
      source: "extraction:turn-evidence-801",
    };

    await expect(
      memoryRepository.create(crossGroupAuth, createInput),
    ).rejects.toThrowError(/AGENT_MEMORY_EVIDENCE_SCOPE_MISMATCH/u);
    const claim = await memoryRepository.create(sourceAuth, createInput);
    await expect(memoryRepository.create(sourceAuth, createInput)).resolves.toEqual(claim);
    const evidence = await claimEvidenceRepository.listByMemoryRef(sourceAuth, claim.memoryRef);
    const persisted = await database().query<{
      endorsed_by_user_id: string | null;
      profile_eligible: boolean;
      provenance_state: string;
      subject_participant_id: string | null;
    }>(
      `SELECT provenance_state, endorsed_by_user_id, profile_eligible, subject_participant_id
       FROM memory_items WHERE id = $1`,
      [claim.id],
    );

    expect(persisted.rows[0]).toEqual({
      endorsed_by_user_id: null,
      profile_eligible: true,
      provenance_state: "evidenced",
      subject_participant_id: expect.any(String),
    });
    expect(evidence).toHaveLength(2);
    expect(evidence.map((item) => item.role).sort()).toEqual(["primary", "supporting"]);
    expect(evidence.find((item) => item.role === "primary")).toMatchObject({
      authorLabelSnapshot: "Пётр",
      conversationLabelSnapshot: "Источник",
      evidenceSnippet: "Летом едем в Казань",
      fullTimelineEntryAvailable: true,
      timelineSequence: "2",
    });
    await expect(database().query(
      "SELECT count(*)::integer AS count FROM claim_evidence WHERE claim_id = $1",
      [claim.id],
    )).resolves.toMatchObject({ rows: [{ count: 2 }] });
  });

  it("keeps ordinary create compatible without inventing provenance", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Legacy create') RETURNING id",
    );
    const user = await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('legacy-901', 'Owner') RETURNING id",
    );
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
      [family.rows[0]!.id, user.rows[0]!.id],
    );
    const auth: MemoryAuthorization = {
      familyId: family.rows[0]!.id,
      groupId: null,
      role: "owner",
      scopes: ["personal", "family"],
      telegramUserId: "legacy-901",
      userId: user.rows[0]!.id,
    };

    const claim = await memoryRepository.create(auth, {
      confirmation: "user_confirmed",
      content: "Обычная запись remember остаётся совместимой",
      kind: "fact",
      operationKey: "ordinary-legacy-create",
      scope: "personal",
      sensitivity: "normal",
      source: "eve:test:ordinary",
    });
    const state = await database().query<{ provenance_state: string }>(
      "SELECT provenance_state FROM memory_items WHERE id = $1",
      [claim.id],
    );

    expect(state.rows[0]?.provenance_state).toBe("legacy_unresolved");
    await expect(claimEvidenceRepository.listByMemoryRef(auth, claim.memoryRef)).resolves.toEqual([]);
  });
});
