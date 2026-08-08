/**
 * Transaction-local persistence for validated claim evidence.
 *
 * Exports:
 * - `insertClaimEvidence`: inserts claim sources and resolves an extraction candidate.
 * - `insertClaimReinforcement`: appends duplicate evidence and resolves reinforcement state.
 *
 * Key constructs:
 * - Approved notices and immutable decisions are finalized in the caller's existing transaction.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import type { PreparedClaimEvidence } from "./claim-evidence-writer.js";

export async function insertClaimEvidence(
  client: PoolClient,
  claimId: string,
  prepared: PreparedClaimEvidence,
): Promise<void> {
  // Every source row carries the same claim/conversation trust partition. PostgreSQL composite FKs
  // independently reject cross-zone claim, conversation, author, and timeline references.
  for (const source of prepared.sources) {
    await client.query(
      `INSERT INTO claim_evidence
         (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
          origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
          author_participant_id, author_user_id, author_label_snapshot, observed_at,
          evidence_snippet, timeline_entry_id, timeline_sequence, source_message_id,
          message_thread_id, source_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14, $15, $16, $17, $18, $19)`,
      [claimId, prepared.familyId, prepared.scope, prepared.scopePartitionKey, source.role,
        prepared.evidenceKind, prepared.conversationId, prepared.conversationLabelSnapshot,
        prepared.telegramGroupId, source.authorParticipantId, source.authorUserId,
        source.authorLabelSnapshot, source.observedAt, source.evidenceSnippet,
        source.timelineEntryId, source.timelineSequence, source.sourceMessageId,
        source.messageThreadId, source.sourceSnapshot],
    );
  }

  // Explicit Telegram evidence has no extraction candidate lifecycle to resolve.
  if (prepared.sourceKind === "explicit") return;

  // Snapshot cleanup is blocked until every candidate has an explicit resolution. Claim creation
  // consumes this candidate in the same transaction as its normalized evidence set.
  const resolutionStatus = prepared.consolidation?.relation === "duplicate"
    ? "duplicate"
    : prepared.consolidation?.relation === "conflict"
      ? "conflict"
      : "claim_created";
  const resolved = await client.query(
    `UPDATE memory_extraction_candidates
     SET resolution_status = $5, resolved_claim_id = $3,
         resolved_at = now(), resolution_lease_token = NULL, resolution_lease_expires_at = NULL
     WHERE candidate_id = $1 AND operation_key = $2
       AND resolution_status = $4`,
    [prepared.candidateId, prepared.operationKey, claimId,
      prepared.resolutionStatus, resolutionStatus],
  );
  if (!resolved.rowCount) {
    throw new AppError(
      "AGENT_MEMORY_EVIDENCE_CANDIDATE_ALREADY_RESOLVED",
      "Кандидат памяти уже был обработан другим решением",
    );
  }
  await resolveApprovedNotice(client, claimId, prepared);
}

async function resolveApprovedNotice(
  client: PoolClient,
  claimId: string,
  prepared: PreparedClaimEvidence,
): Promise<void> {
  if (prepared.approval === null) return;
  const approval = prepared.approval;
  const resolved = await client.query(
    `UPDATE memory_extraction_approval_notices
     SET status = 'approved', resolved_at = now(), resolved_by_user_id = $2,
         resolved_by_telegram_user_id = $3, decision_operation_key = $4
     WHERE approval_ref = $1 AND status = 'pending'`,
    [approval.ref, approval.actorUserId, approval.actorTelegramUserId, approval.operationKey],
  );
  if (!resolved.rowCount) {
    throw new AppError(
      "AGENT_MEMORY_APPROVAL_ALREADY_RESOLVED",
      "Это подтверждение памяти уже обработано",
    );
  }
  await client.query(
    `INSERT INTO memory_sensitive_approval_decisions
       (family_id, approval_ref, operation_key, input_hash, decision,
        decided_by_user_id, decided_by_telegram_user_id, resolved_claim_id)
     VALUES ($1, $2, $3, $4, 'approve', $5, $6, $7)`,
    [prepared.familyId, approval.ref, approval.operationKey, approval.inputHash,
      approval.actorUserId, approval.actorTelegramUserId, claimId],
  );
}

export async function insertClaimReinforcement(
  client: PoolClient,
  claimId: string,
  prepared: PreparedClaimEvidence,
): Promise<void> {
  // An exact duplicate adds evidence without inventing a second primary or a second claim.
  for (const source of prepared.sources) {
    await client.query(
      `INSERT INTO claim_evidence
         (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
          origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
          author_participant_id, author_user_id, author_label_snapshot, observed_at,
          evidence_snippet, timeline_entry_id, timeline_sequence, source_message_id,
          message_thread_id, source_snapshot)
       VALUES ($1, $2, $3, $4, 'reinforcement', $5, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16, $17, $18)`,
      [claimId, prepared.familyId, prepared.scope, prepared.scopePartitionKey,
        prepared.evidenceKind, prepared.conversationId, prepared.conversationLabelSnapshot,
        prepared.telegramGroupId, source.authorParticipantId, source.authorUserId,
        source.authorLabelSnapshot, source.observedAt, source.evidenceSnippet,
        source.timelineEntryId, source.timelineSequence, source.sourceMessageId,
        source.messageThreadId, source.sourceSnapshot],
    );
  }
  // Explicit reinforcement consumes no extraction candidate or approval notice.
  if (prepared.sourceKind === "explicit") return;
  const resolved = await client.query(
    `UPDATE memory_extraction_candidates
     SET resolution_status = 'reinforced', resolved_claim_id = $3, resolved_at = now(),
         resolution_lease_token = NULL, resolution_lease_expires_at = NULL
     WHERE candidate_id = $1 AND operation_key = $2 AND resolution_status = $4`,
    [prepared.candidateId, prepared.operationKey, claimId, prepared.resolutionStatus],
  );
  if (!resolved.rowCount) {
    throw new AppError(
      "AGENT_MEMORY_EVIDENCE_CANDIDATE_ALREADY_RESOLVED",
      "Кандидат памяти уже был обработан другим решением",
    );
  }
  await resolveApprovedNotice(client, claimId, prepared);
}
