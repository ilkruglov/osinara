/**
 * Validated claim-evidence write preparation for the single memory writer transaction.
 *
 * Exports:
 * - `PreparedClaimEvidence`: trusted claim fields and normalized source rows derived from PostgreSQL.
 * - `prepareClaimEvidence`: validates candidate, trust zone, subject, and exact durable snapshots.
 * - `insertClaimEvidence` and `insertClaimReinforcement`: re-export transaction persistence helpers.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import type { MemoryConsolidationResolution } from "./memory-consolidation-contract.js";
import { MEMORY_EVIDENCE_SNIPPET_MAX_CHARACTERS } from "./memory-config.js";
import type { MemoryAuthorization } from "./memory-context.js";
import type { CreateMemoryInput } from "./memory-record.js";
import { normalizeMemoryClaimContent } from "./memory-record.js";
import {
  prepareSensitiveApproval,
  type PreparedSensitiveApproval,
} from "./memory-sensitive-approval-authorization.js";

export {
  insertClaimEvidence,
  insertClaimReinforcement,
} from "./claim-evidence-persistence.js";

export interface PreparedEvidenceSource {
  authorLabelSnapshot: string | null;
  authorParticipantId: string;
  authorUserId: string | null;
  authorTelegramUserId: string;
  evidenceSnippet: string;
  messageThreadId: string | null;
  observedAt: Date;
  role: "primary" | "supporting";
  sourceMessageId: string;
  sourceSnapshot: Record<string, string | null>;
  timelineEntryId: string | null;
  timelineSequence: string;
}

export interface PreparedClaimEvidence {
  approval: PreparedSensitiveApproval | null;
  auditActorUserId: string | null;
  candidateId: string;
  contentNormalized: string;
  consolidation: MemoryConsolidationResolution | null;
  conversationId: string;
  conversationLabelSnapshot: string;
  evidenceKind: "firsthand" | "inferred" | "reported";
  familyId: string;
  operationKey: string;
  primaryAuthorTelegramUserId: string;
  primaryAuthorUserId: string | null;
  resolutionStatus: "approval_pending" | "resolution_processing";
  scope: "family" | "group" | "personal";
  scopePartitionKey: string;
  sources: PreparedEvidenceSource[];
  sourceKind: "explicit" | "extraction";
  subjectConversationId: string | null;
  subjectLabel: string | null;
  subjectParticipantId: string | null;
  subjectUserId: string | null;
  telegramGroupId: string | null;
}

function snippet(content: string): string {
  const bounded = [...content.trim()].slice(0, MEMORY_EVIDENCE_SNIPPET_MAX_CHARACTERS).join("");
  if (!bounded) {
    throw new AppError(
      "AGENT_MEMORY_EVIDENCE_SOURCE_EMPTY",
      "Источник кандидата не содержит текста для проверяемого evidence",
    );
  }
  return bounded;
}

export async function prepareClaimEvidence(
  client: PoolClient,
  auth: MemoryAuthorization,
  input: CreateMemoryInput,
  approvalActor?: MemoryAuthorization,
): Promise<PreparedClaimEvidence | null> {
  if (!input.evidence) return null;
  const candidates = await client.query<{
    batch_status: string;
    caller_user_id: string | null;
    candidate_row_id: string;
    content: string;
    consolidation_status:
      | "conflict"
      | "correction"
      | "duplicate"
      | "new"
      | "refinement"
      | "temporal_update"
      | null;
    consolidation_target_claim_id: string | null;
    conversation_id: string;
    conversation_label: string;
    evidence_kind: "firsthand" | "inferred" | "reported";
    family_id: string;
    kind: string;
    operation_key: string;
    resolution_status: "approval_pending" | "resolution_processing";
    owner_user_id: string | null;
    scope: "family" | "group" | "personal";
    scope_partition_key: string;
    sensitivity: string;
    snapshot_erased_at: Date | null;
    subject_label: string | null;
    subject_participant_ref: string | null;
    telegram_group_id: string | null;
  }>(
    `SELECT candidate.id AS candidate_row_id, candidate.content, candidate.kind::text, candidate.sensitivity::text,
            candidate.evidence_kind, candidate.operation_key, candidate.resolution_status,
            candidate.subject_participant_ref,
             candidate.subject_label, batch.family_id, batch.scope, batch.scope_partition_key,
             batch.caller_user_id,
             batch.conversation_id, batch.status AS batch_status, batch.snapshot_erased_at,
             conversation.label AS conversation_label,
              conversation.owner_user_id, conversation.telegram_group_id,
              consolidation.status AS consolidation_status,
              consolidation.selected_existing_claim_id AS consolidation_target_claim_id
     FROM memory_extraction_candidates AS candidate
     JOIN memory_extraction_jobs AS job ON job.id = candidate.job_id
     JOIN memory_extraction_batches AS batch ON batch.id = candidate.batch_id
     JOIN application_conversations AS conversation ON conversation.id = batch.conversation_id
     LEFT JOIN LATERAL (
       SELECT status, selected_existing_claim_id
       FROM memory_consolidation_jobs
       WHERE candidate_row_id = candidate.id
         AND status IN ('new', 'duplicate', 'refinement', 'temporal_update', 'correction', 'conflict')
       ORDER BY attempt DESC LIMIT 1
     ) AS consolidation ON true
     WHERE candidate.candidate_id = $1 AND candidate.operation_key = $2
       AND job.status = 'completed'`,
    [input.evidence.extractionCandidateId, input.operationKey],
  );
  const candidate = candidates.rows[0];
  if (
    !candidate ||
    candidate.batch_status !== "completed" ||
    candidate.snapshot_erased_at !== null ||
    candidate.resolution_status !== (
      input.evidence.approvalRef ? "approval_pending" : "resolution_processing"
    )
  ) {
    throw new AppError(
      "AGENT_MEMORY_EVIDENCE_CANDIDATE_INVALID",
      "Кандидат памяти не завершён или его временный снимок уже удалён",
    );
  }

  // Scope and author are application-owned. The caller can consume only a candidate from the exact
  // family/group partition already present in verified authorization.
  const expectedPartition = candidate.scope === "group"
    ? auth.groupId
    : candidate.scope === "personal"
      ? auth.userId
      : auth.familyId;
  if (
    candidate.family_id !== auth.familyId ||
    candidate.scope !== input.scope ||
    candidate.scope_partition_key !== expectedPartition
  ) {
    throw new AppError(
      "AGENT_MEMORY_EVIDENCE_SCOPE_MISMATCH",
      "Источник кандидата относится к другой области памяти",
    );
  }
  if (
    candidate.content !== input.content ||
    candidate.kind !== input.kind ||
    candidate.sensitivity !== input.sensitivity
  ) {
    throw new AppError(
      "AGENT_MEMORY_EVIDENCE_CANDIDATE_MISMATCH",
      "Текст или тип claim не совпадает с проверенным кандидатом",
    );
  }

  let subjectParticipantId: string | null = null;
  let subjectConversationId: string | null = null;
  let subjectUserId: string | null = null;
  let subjectLabel = candidate.subject_label;
  if (candidate.subject_participant_ref !== null) {
    const subjects = await client.query<{
      display_name_snapshot: string | null;
      id: string;
      linked_user_id: string | null;
    }>(
      `SELECT id, linked_user_id, display_name_snapshot FROM conversation_participants
       WHERE conversation_id = $1 AND participant_ref = $2`,
      [candidate.conversation_id, candidate.subject_participant_ref],
    );
    const subject = subjects.rows[0];
    if (!subject) {
      throw new AppError(
        "AGENT_MEMORY_EVIDENCE_SUBJECT_INVALID",
        "Проверенный субъект больше не принадлежит исходному разговору",
      );
    }
    // External identity remains strictly participant-local. Trusted family/personal scopes may use
    // only the exact Telegram-ID linkage already persisted by the application.
    if (candidate.scope === "group") {
      subjectParticipantId = subject.id;
      subjectConversationId = candidate.conversation_id;
    } else if (subject.linked_user_id !== null) {
      subjectUserId = subject.linked_user_id;
    }
    subjectLabel = subject.display_name_snapshot;
  }

  const sourceRows = await client.query<{
    actor_label_snapshot: string | null;
    author_participant_id: string | null;
    author_user_id: string | null;
    author_telegram_user_id: string;
    content_hash: string;
    content_text: string | null;
    message_thread_id: string | null;
    observed_at: Date;
    source_message_id: string;
    source_role: "primary" | "supporting";
    timeline_entry_id: string | null;
    timeline_entry_id_snapshot: string;
    timeline_sequence: string;
  }>(
    `SELECT source.source_role, snapshot.timeline_entry_id,
            snapshot.timeline_entry_id_snapshot::text, snapshot.sequence_id::text AS timeline_sequence,
            snapshot.telegram_message_id::text AS source_message_id,
            snapshot.message_thread_id::text, snapshot.observed_at,
            snapshot.actor_label_snapshot, snapshot.content_text, snapshot.content_hash,
             snapshot.author_participant_id, participant.linked_user_id AS author_user_id,
             participant.telegram_user_id AS author_telegram_user_id
     FROM memory_extraction_candidate_sources AS source
     JOIN memory_extraction_candidates AS candidate ON candidate.id = source.candidate_row_id
     JOIN memory_extraction_snapshot_entries AS snapshot ON snapshot.id = source.snapshot_entry_id
     JOIN conversation_participants AS participant ON participant.id = snapshot.author_participant_id
     WHERE candidate.candidate_id = $1 AND candidate.operation_key = $2
       AND snapshot.batch_id = candidate.batch_id AND snapshot.erased_at IS NULL
     ORDER BY CASE source.source_role WHEN 'primary' THEN 0 ELSE 1 END, source.source_order`,
    [input.evidence.extractionCandidateId, input.operationKey],
  );
  if (
    sourceRows.rows.length === 0 ||
    sourceRows.rows.filter((source) => source.source_role === "primary").length !== 1 ||
    sourceRows.rows.some((source) => source.author_participant_id === null || source.content_text === null)
  ) {
    throw new AppError(
      "AGENT_MEMORY_EVIDENCE_SOURCE_INVALID",
      "Кандидат не содержит ровно один primary и проверенные source snapshots",
    );
  }

  const primary = sourceRows.rows.find((source) => source.source_role === "primary")!;
  const approval = await prepareSensitiveApproval(
    client,
    input,
    candidate,
    primary,
    approvalActor,
  );
  if (
    candidate.evidence_kind === "firsthand" &&
    candidate.subject_participant_ref !== null &&
    subjectRowsAuthorMismatch(subjectParticipantId, subjectUserId, primary)
  ) {
    throw new AppError(
      "AGENT_MEMORY_EVIDENCE_FIRSTHAND_SUBJECT_INVALID",
      "Субъект firsthand-утверждения не совпадает с проверенным автором источника",
    );
  }
  if (candidate.scope === "personal" && primary.author_user_id !== candidate.owner_user_id) {
    throw new AppError(
      "AGENT_MEMORY_EVIDENCE_AUTHOR_INVALID",
      "Личный источник не принадлежит владельцу разговора",
    );
  }
  if (candidate.scope === "family") {
    const sourceUserIds = [...new Set(sourceRows.rows.map((source) => source.author_user_id))];
    if (sourceUserIds.some((userId) => userId === null)) {
      throw new AppError(
        "AGENT_MEMORY_EVIDENCE_AUTHOR_NOT_MEMBER",
        "Один или несколько авторов семейных источников больше не состоят в этой семье",
      );
    }
    const memberships = await client.query<{ user_id: string }>(
      `SELECT user_id FROM family_memberships
       WHERE family_id = $1 AND user_id = ANY($2::uuid[]) FOR SHARE`,
      [candidate.family_id, sourceUserIds],
    );
    if (memberships.rows.length !== sourceUserIds.length) {
      throw new AppError(
        "AGENT_MEMORY_EVIDENCE_AUTHOR_NOT_MEMBER",
        "Один или несколько авторов семейных источников больше не состоят в этой семье",
      );
    }
  }

  const sources = sourceRows.rows.map((source): PreparedEvidenceSource => ({
    authorLabelSnapshot: source.actor_label_snapshot,
    authorParticipantId: source.author_participant_id!,
    authorUserId: source.author_user_id,
    authorTelegramUserId: source.author_telegram_user_id,
    evidenceSnippet: snippet(source.content_text!),
    messageThreadId: source.message_thread_id,
    observedAt: source.observed_at,
    role: source.source_role,
    sourceMessageId: source.source_message_id,
    sourceSnapshot: {
      contentHash: source.content_hash,
      messageThreadId: source.message_thread_id,
      sourceMessageId: source.source_message_id,
      timelineEntryId: source.timeline_entry_id_snapshot,
      timelineSequence: source.timeline_sequence,
    },
    timelineEntryId: source.timeline_entry_id,
    timelineSequence: source.timeline_sequence,
  }));
  return {
    approval,
    auditActorUserId: approval?.actorUserId ?? candidate.caller_user_id,
    candidateId: input.evidence.extractionCandidateId,
    contentNormalized: normalizeMemoryClaimContent(candidate.content),
    consolidation: candidate.consolidation_status === null
      ? null
      : {
          relation: candidate.consolidation_status,
          targetClaimId: candidate.consolidation_target_claim_id,
        },
    conversationId: candidate.conversation_id,
    conversationLabelSnapshot: candidate.conversation_label,
    evidenceKind: candidate.evidence_kind,
    familyId: candidate.family_id,
    operationKey: candidate.operation_key,
    primaryAuthorTelegramUserId: primary.author_telegram_user_id,
    primaryAuthorUserId: primary.author_user_id,
    resolutionStatus: candidate.resolution_status,
    scope: candidate.scope,
    scopePartitionKey: candidate.scope_partition_key,
    sources,
    sourceKind: "extraction",
    subjectConversationId,
    subjectLabel,
    subjectParticipantId,
    subjectUserId,
    telegramGroupId: candidate.telegram_group_id,
  };
}

function subjectRowsAuthorMismatch(
  subjectParticipantId: string | null,
  subjectUserId: string | null,
  primary: { author_participant_id: string | null; author_user_id: string | null },
): boolean {
  return subjectParticipantId !== null
    ? subjectParticipantId !== primary.author_participant_id
    : subjectUserId !== null && subjectUserId !== primary.author_user_id;
}
