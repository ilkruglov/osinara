/**
 * Application consolidation for completed semantic extraction candidates.
 *
 * Exports:
 * - `processMemoryExtractionCandidates`: idempotent scope/content/approval/single-writer handling.
 * - `processNextPendingMemoryExtractionCandidates`: crash recovery for completed unresolved output.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { memoryContentRejectionCode } from "./memory-content-policy.js";
import { memoryConsolidationJobRepository } from "./memory-consolidation-job-repository.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { memoryRepository } from "./memory-repository.js";
import { memoryThreadDiscoveryRepository } from "./memory-thread-discovery-repository.js";
import { MEMORY_CANDIDATE_RESOLUTION_LEASE_MILLISECONDS } from "./memory-config.js";

interface PendingCandidate {
  action: "needs_approval" | "save";
  candidate_id: string;
  content: string;
  evidence_kind: "firsthand" | "inferred" | "reported";
  family_id: string;
  group_id: string | null;
  id: string;
  kind: "episode" | "fact" | "family_shared" | "preference" | "profile";
  linked_user_id: string | null;
  message_thread_id: string | null;
  operation_key: string;
  owner_user_id: string | null;
  proposed_thread_continuation: boolean;
  scope: "family" | "group" | "personal";
  sensitivity: "normal" | "sensitive";
  telegram_user_id: string;
  resolution_lease_token: string;
}

function candidateDiagnostic(error: unknown): string {
  return error instanceof AppError ? error.code : "AGENT_MEMORY_CANDIDATE_RESOLUTION_FAILED";
}

function authorization(candidate: PendingCandidate): MemoryAuthorization {
  if (candidate.scope === "personal") {
    if (!candidate.owner_user_id || candidate.linked_user_id !== candidate.owner_user_id) {
      throw new AppError(
        "AGENT_MEMORY_EXTRACTION_PERSONAL_AUTHOR_INVALID",
        "Личный candidate не принадлежит владельцу исходного разговора",
      );
    }
    return {
      familyId: candidate.family_id,
      groupId: null,
      role: "member",
      scopes: ["personal"],
      telegramUserId: candidate.telegram_user_id,
      userId: candidate.owner_user_id,
    };
  }
  if (candidate.scope === "family") {
    if (!candidate.linked_user_id) {
      throw new AppError(
        "AGENT_MEMORY_EXTRACTION_FAMILY_AUTHOR_INVALID",
        "Семейный candidate не имеет текущего verified автора",
      );
    }
    return {
      familyId: candidate.family_id,
      groupId: null,
      role: "member",
      scopes: ["family"],
      telegramUserId: candidate.telegram_user_id,
      userId: candidate.linked_user_id,
    };
  }
  if (!candidate.group_id) {
    throw new AppError(
      "AGENT_MEMORY_EXTRACTION_GROUP_INVALID",
      "External candidate потерял исходную группу",
    );
  }
  return {
    familyId: candidate.family_id,
    groupId: candidate.group_id,
    role: candidate.linked_user_id ? "member" : "external",
    scopes: ["group"],
    telegramUserId: candidate.telegram_user_id,
    userId: candidate.linked_user_id,
  };
}

async function resolveWithoutClaim(
  candidate: PendingCandidate,
  diagnosticCode: string,
  approval: boolean,
): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const resolved = await client.query(
      approval
        ? `UPDATE memory_extraction_candidates
           SET resolution_status = 'approval_pending'
               , resolution_lease_token = NULL, resolution_lease_expires_at = NULL
           WHERE id = $1 AND resolution_status = 'resolution_processing'
             AND resolution_lease_token = $2`
         : `UPDATE memory_extraction_candidates
           SET resolution_status = 'rejected', resolution_diagnostic_code = $2, resolved_at = now()
               , resolution_lease_token = NULL, resolution_lease_expires_at = NULL
           WHERE id = $1 AND resolution_status = 'resolution_processing'
             AND resolution_lease_token = $3`,
      approval
        ? [candidate.id, candidate.resolution_lease_token]
        : [candidate.id, diagnosticCode, candidate.resolution_lease_token],
    );
    if (resolved.rowCount && approval) {
      await client.query(
        `INSERT INTO memory_extraction_approval_notices
           (candidate_row_id, family_id, conversation_id)
         SELECT candidate.id, batch.family_id, batch.conversation_id
         FROM memory_extraction_candidates AS candidate
         JOIN memory_extraction_batches AS batch ON batch.id = candidate.batch_id
         WHERE candidate.id = $1 ON CONFLICT (candidate_row_id) DO NOTHING`,
        [candidate.id],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function claimPendingCandidate(batchId: string | null): Promise<PendingCandidate | null> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    // Local resolution has no external side effect, but an expired attempt is terminal and explicit.
    await client.query(
      `UPDATE memory_extraction_candidates
       SET resolution_status = 'resolution_failed',
           resolution_diagnostic_code = 'AGENT_MEMORY_CANDIDATE_LEASE_EXPIRED',
           resolution_lease_token = NULL, resolution_lease_expires_at = NULL, resolved_at = now()
       WHERE resolution_status = 'resolution_processing' AND resolution_lease_expires_at < now()`,
    );
    const claimed = await client.query<{ id: string; resolution_lease_token: string }>(
      `WITH next AS (
         SELECT candidate.id
         FROM memory_extraction_candidates AS candidate
         JOIN memory_extraction_batches AS batch ON batch.id = candidate.batch_id
         WHERE candidate.resolution_status = 'pending' AND batch.status = 'completed'
           AND ($1::uuid IS NULL OR candidate.batch_id = $1)
         ORDER BY batch.created_at, candidate.batch_id, candidate.created_at, candidate.id
         FOR UPDATE OF candidate SKIP LOCKED LIMIT 1
       )
       UPDATE memory_extraction_candidates AS candidate
       SET resolution_status = 'resolution_processing',
           resolution_attempts = resolution_attempts + 1,
           resolution_lease_token = gen_random_uuid(),
           resolution_lease_expires_at = now() + ($2::text || ' milliseconds')::interval
       FROM next WHERE candidate.id = next.id
       RETURNING candidate.id, candidate.resolution_lease_token::text`,
      [batchId, MEMORY_CANDIDATE_RESOLUTION_LEASE_MILLISECONDS],
    );
    const lease = claimed.rows[0];
    if (!lease) {
      await client.query("COMMIT");
      return null;
    }
    const pending = await client.query<PendingCandidate>(
      `SELECT candidate.id, candidate.candidate_id, candidate.operation_key, candidate.content,
             candidate.kind, candidate.sensitivity, candidate.evidence_kind,
             candidate.proposed_thread_continuation, candidate.resolution_lease_token::text,
             semantic.action,
             batch.family_id, batch.scope, conversation.owner_user_id,
             conversation.telegram_group_id AS group_id, primary_snapshot.message_thread_id::text,
             participant.linked_user_id, participant.telegram_user_id
     FROM memory_extraction_candidates AS candidate
     JOIN memory_extraction_semantic_results AS semantic ON semantic.candidate_row_id = candidate.id
     JOIN memory_extraction_batches AS batch ON batch.id = candidate.batch_id
     JOIN application_conversations AS conversation ON conversation.id = batch.conversation_id
     JOIN memory_extraction_candidate_sources AS source
       ON source.candidate_row_id = candidate.id AND source.source_role = 'primary'
     JOIN memory_extraction_snapshot_entries AS primary_snapshot ON primary_snapshot.id = source.snapshot_entry_id
     JOIN conversation_participants AS participant ON participant.id = primary_snapshot.author_participant_id
       WHERE candidate.id = $1 AND candidate.resolution_status = 'resolution_processing'
         AND candidate.resolution_lease_token = $2`,
      [lease.id, lease.resolution_lease_token],
    );
    await client.query("COMMIT");
    const candidate = pending.rows[0];
    if (!candidate || candidate.content === null) {
      throw new AppError(
        "AGENT_MEMORY_CANDIDATE_INPUT_MISSING",
        "Кандидат памяти потерял обязательный текст до завершения обработки",
      );
    }
    return candidate;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function failCandidate(candidate: PendingCandidate, error: unknown): Promise<void> {
  const result = await database().query(
    `UPDATE memory_extraction_candidates
     SET resolution_status = 'resolution_failed', resolution_diagnostic_code = $3,
         resolution_lease_token = NULL, resolution_lease_expires_at = NULL, resolved_at = now()
     WHERE id = $1 AND resolution_status = 'resolution_processing'
       AND resolution_lease_token = $2`,
    [candidate.id, candidate.resolution_lease_token, candidateDiagnostic(error)],
  );
  if (!result.rowCount) throw error;
  console.error(JSON.stringify({
    candidateId: candidate.candidate_id,
    code: candidateDiagnostic(error),
    error: error instanceof Error ? error.message : String(error),
  }));
}

async function processCandidate(candidate: PendingCandidate): Promise<void> {
  try {
    const rejectionCode = memoryContentRejectionCode(candidate.content);
    if (rejectionCode) {
      await resolveWithoutClaim(candidate, rejectionCode, false);
      return;
    }
    if (
      candidate.action === "needs_approval" ||
      candidate.sensitivity === "sensitive"
    ) {
      await resolveWithoutClaim(candidate, "AGENT_MEMORY_EXTRACTION_APPROVAL_REQUIRED", true);
      return;
    }
    const auth = authorization(candidate);
    const stage = await memoryConsolidationJobRepository.stageCandidate(candidate.id);
    if (stage === "pending") return;
    const claim = await memoryRepository.create(auth, {
      confirmation: "model_high",
      content: candidate.content,
      evidence: { extractionCandidateId: candidate.candidate_id },
      kind: candidate.kind,
      ...(candidate.message_thread_id === null
        ? {}
        : { messageThreadId: candidate.message_thread_id }),
      operationKey: candidate.operation_key,
      scope: candidate.scope,
      sensitivity: candidate.sensitivity,
      source: "automatic_extraction",
    });
    // The durable claim commits before discovery. A separate catch-up scan closes this narrow crash gap.
    await memoryThreadDiscoveryRepository.stageImmediateCandidate(
      claim.id,
      candidate.proposed_thread_continuation,
    );
  } catch (error) {
    await failCandidate(candidate, error);
  }
}

export async function processMemoryExtractionCandidates(batchId: string): Promise<number> {
  let processed = 0;
  while (true) {
    const candidate = await claimPendingCandidate(batchId);
    if (!candidate) return processed;
    await processCandidate(candidate);
    processed += 1;
  }
}

export async function processNextPendingMemoryExtractionCandidates(): Promise<boolean> {
  const candidate = await claimPendingCandidate(null);
  if (!candidate) return false;
  await processCandidate(candidate);
  return true;
}
