/**
 * Replay-protected approve/reject boundary for pending sensitive extraction candidates.
 *
 * Exports:
 * - `SensitiveApprovalResult`: terminal model-safe decision result.
 * - `memorySensitiveApprovalRepository.resolve`: current-authority resolution via the single writer.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import { createMemoryClaim } from "./memory-claim-writer.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { database } from "./database.js";
import { memoryOperationHash, type MemoryKind } from "./memory-record.js";

type QueryClient = Pick<PoolClient, "query">;

export type SensitiveApprovalResult =
  | { memoryRef: string; status: "approved" }
  | { status: "rejected" };

interface CandidateRow {
  candidate_id: string;
  content: string;
  family_id: string;
  group_id: string | null;
  kind: MemoryKind;
  message_thread_id: string | null;
  operation_key: string;
  owner_user_id: string | null;
  scope: "family" | "group" | "personal";
}

async function replayDecision(
  client: QueryClient,
  auth: MemoryAuthorization,
  input: { action: "approve" | "reject"; approvalRef: string; operationKey: string },
  inputHash: string,
): Promise<SensitiveApprovalResult | null> {
  const result = await client.query<{
    approval_ref: string;
    decision: "approve" | "reject";
    input_hash: string;
    memory_ref: string | null;
  }>(
    `SELECT decision.approval_ref, decision.input_hash, decision.decision,
            ref.memory_ref
     FROM memory_sensitive_approval_decisions AS decision
     LEFT JOIN memory_item_refs AS ref ON ref.memory_item_id = decision.resolved_claim_id
     WHERE decision.family_id = $1 AND decision.operation_key = $2`,
    [auth.familyId, input.operationKey],
  );
  const replay = result.rows[0];
  if (!replay) return null;
  if (
    replay.input_hash !== inputHash ||
    replay.approval_ref !== input.approvalRef ||
    replay.decision !== input.action
  ) {
    throw new AppError(
      "AGENT_MEMORY_APPROVAL_REPLAY_MISMATCH",
      "Повтор решения не совпадает с исходным подтверждением памяти",
    );
  }
  if (replay.decision === "reject") return { status: "rejected" };
  if (!replay.memory_ref) {
    throw new AppError(
      "AGENT_MEMORY_APPROVAL_RESULT_REMOVED",
      "Подтверждённая запись памяти уже удалена",
    );
  }
  return { memoryRef: replay.memory_ref, status: "approved" };
}

async function loadAuthorizedCandidate(
  client: QueryClient,
  auth: MemoryAuthorization,
  approvalRef: string,
  lock: boolean,
): Promise<CandidateRow> {
  const result = await client.query<CandidateRow>(
    `SELECT candidate.candidate_id, candidate.operation_key, candidate.content,
            candidate.kind, batch.family_id, batch.scope,
            conversation.owner_user_id, conversation.telegram_group_id AS group_id,
            primary_snapshot.message_thread_id::text
     FROM memory_extraction_approval_notices AS notice
     JOIN memory_extraction_candidates AS candidate ON candidate.id = notice.candidate_row_id
     JOIN memory_extraction_batches AS batch ON batch.id = candidate.batch_id
     JOIN application_conversations AS conversation ON conversation.id = batch.conversation_id
     JOIN memory_extraction_candidate_sources AS source
       ON source.candidate_row_id = candidate.id AND source.source_role = 'primary'
     JOIN memory_extraction_snapshot_entries AS primary_snapshot
       ON primary_snapshot.id = source.snapshot_entry_id
     JOIN conversation_participants AS author
       ON author.id = primary_snapshot.author_participant_id
     WHERE notice.approval_ref = $1 AND notice.family_id = $2
       AND notice.status = 'pending' AND candidate.resolution_status = 'approval_pending'
       AND (
         (batch.scope = 'personal' AND author.linked_user_id = $3) OR
         (batch.scope = 'family' AND author.linked_user_id = $3 AND EXISTS (
           SELECT 1 FROM family_memberships
           WHERE family_id = batch.family_id AND user_id = $3
         )) OR
         (batch.scope = 'group' AND author.telegram_user_id = $4) OR
         (batch.scope IN ('family', 'group') AND EXISTS (
           SELECT 1 FROM family_memberships
           WHERE family_id = batch.family_id AND user_id = $3 AND role = 'owner'
         ))
       )
     ${lock ? "FOR UPDATE OF notice, candidate" : ""}`,
    [approvalRef, auth.familyId, auth.userId, auth.telegramUserId],
  );
  const candidate = result.rows[0];
  if (!candidate) {
    throw new AppError(
      "AGENT_MEMORY_APPROVAL_DENIED",
      "Подтверждение не найдено, уже обработано или недоступно этому пользователю",
    );
  }
  return candidate;
}

function writerAuthorization(
  actor: MemoryAuthorization,
  candidate: CandidateRow,
): MemoryAuthorization {
  if (candidate.scope === "personal") {
    if (!candidate.owner_user_id) {
      throw new AppError(
        "AGENT_MEMORY_APPROVAL_CONTEXT_INVALID",
        "У личного кандидата отсутствует проверенный владелец",
      );
    }
    return { ...actor, groupId: null, scopes: ["personal"], userId: candidate.owner_user_id };
  }
  if (candidate.scope === "family") return { ...actor, groupId: null, scopes: ["family"] };
  if (!candidate.group_id) {
    throw new AppError(
      "AGENT_MEMORY_APPROVAL_CONTEXT_INVALID",
      "У группового кандидата отсутствует исходная группа",
    );
  }
  return { ...actor, groupId: candidate.group_id, scopes: ["group"] };
}

export const memorySensitiveApprovalRepository = {
  async resolve(
    auth: MemoryAuthorization,
    input: { action: "approve" | "reject"; approvalRef: string; operationKey: string },
  ): Promise<SensitiveApprovalResult> {
    const inputHash = memoryOperationHash({ action: input.action, approvalRef: input.approvalRef });
    const prior = await replayDecision(database(), auth, input, inputHash);
    if (prior) return prior;

    if (input.action === "approve") {
      const candidate = await loadAuthorizedCandidate(database(), auth, input.approvalRef, false);
      const memory = await createMemoryClaim(writerAuthorization(auth, candidate), {
        confirmation: "user_confirmed",
        content: candidate.content,
        evidence: {
          approvalInputHash: inputHash,
          approvalOperationKey: input.operationKey,
          approvalRef: input.approvalRef,
          extractionCandidateId: candidate.candidate_id,
        },
        kind: candidate.kind,
        ...(candidate.message_thread_id === null
          ? {}
          : { messageThreadId: candidate.message_thread_id }),
        operationKey: candidate.operation_key,
        scope: candidate.scope,
        sensitivity: "sensitive",
        source: "approved_sensitive_extraction",
      }, auth);
      return { memoryRef: memory.memoryRef, status: "approved" };
    }

    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const replay = await replayDecision(client, auth, input, inputHash);
      if (replay) {
        await client.query("COMMIT");
        return replay;
      }
      const candidate = await loadAuthorizedCandidate(client, auth, input.approvalRef, true);
      const rejected = await client.query(
        `UPDATE memory_extraction_candidates
         SET resolution_status = 'rejected',
             resolution_diagnostic_code = 'AGENT_MEMORY_SENSITIVE_REJECTED', resolved_at = now()
         WHERE candidate_id = $1 AND resolution_status = 'approval_pending'`,
        [candidate.candidate_id],
      );
      if (!rejected.rowCount) {
        throw new AppError(
          "AGENT_MEMORY_APPROVAL_ALREADY_RESOLVED",
          "Это подтверждение памяти уже обработано",
        );
      }
      await client.query(
        `UPDATE memory_extraction_approval_notices
         SET status = 'rejected', resolved_at = now(), resolved_by_user_id = $2,
             resolved_by_telegram_user_id = $3, decision_operation_key = $4
         WHERE approval_ref = $1 AND status = 'pending'`,
        [input.approvalRef, auth.userId, auth.telegramUserId, input.operationKey],
      );
      await client.query(
        `INSERT INTO memory_sensitive_approval_decisions
           (family_id, approval_ref, operation_key, input_hash, decision,
            decided_by_user_id, decided_by_telegram_user_id)
         VALUES ($1, $2, $3, $4, 'reject', $5, $6)`,
        [auth.familyId, input.approvalRef, input.operationKey, inputHash,
          auth.userId, auth.telegramUserId],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, metadata)
         VALUES ($1, $2, 'memory.sensitive_rejected',
                 jsonb_build_object('approvalRef', $3::text))`,
        [auth.familyId, auth.userId, input.approvalRef],
      );
      await client.query("COMMIT");
      return { status: "rejected" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
