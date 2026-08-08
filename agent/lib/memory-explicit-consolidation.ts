/**
 * Durable synchronous consolidation for explicit remember-compatible writes.
 *
 * Export:
 * - `consolidateExplicitMemoryCreate`: exact/no-candidate fast path or one marked classifier pass.
 */
import { randomUUID } from "node:crypto";

import { AppError } from "./app-error.js";
import { database } from "./database.js";
import type { MemoryConsolidationResolution } from "./memory-consolidation-contract.js";
import { guardConsolidationDecision } from "./memory-consolidation-guards.js";
import {
  MEMORY_CONSOLIDATION_CANDIDATE_LIMIT,
  MEMORY_CONSOLIDATION_JOB_LEASE_MILLISECONDS,
  MEMORY_CONSOLIDATION_MIN_TRIGRAM_SIMILARITY,
} from "./memory-config.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { classifyMemoryRelations } from "./memory-relation-classifier.js";
import {
  memoryOperationHash,
  normalizeMemoryClaimContent,
  type CreateMemoryInput,
} from "./memory-record.js";

interface ExistingRow {
  author_ref: string | null;
  candidate_ref: string;
  content: string;
  evidence_kind: "explicit" | "firsthand" | "inferred" | "reported";
  id: string;
  kind: CreateMemoryInput["kind"];
  similarity: number | string;
}

function authorRef(auth: MemoryAuthorization): string {
  if (auth.userId) return `user:${auth.userId}`;
  if (auth.telegramUserId) return `telegram:${auth.telegramUserId}`;
  throw new AppError(
    "AGENT_MEMORY_CONTEXT_INVALID",
    "Не удалось определить автора explicit memory consolidation",
  );
}

function partition(auth: MemoryAuthorization, input: CreateMemoryInput): string {
  if (input.scope === "personal" && auth.userId) return auth.userId;
  if (input.scope === "family") return auth.familyId;
  if (input.scope === "group" && auth.groupId) return auth.groupId;
  throw new AppError(
    "AGENT_MEMORY_CONTEXT_INVALID",
    "Не удалось определить trust zone explicit memory consolidation",
  );
}

function stableCode(error: unknown): string {
  return error instanceof AppError
    ? error.code
    : "AGENT_MEMORY_CONSOLIDATION_PROVIDER_FAILED";
}

export async function consolidateExplicitMemoryCreate(
  auth: MemoryAuthorization,
  input: CreateMemoryInput,
): Promise<MemoryConsolidationResolution | null> {
  // Replay validation remains in the writer; this read only prevents a second provider call.
  const replay = await database().query(
    `SELECT 1 FROM memory_mutation_operations
     WHERE family_id = $1 AND operation_key = $2`,
    [auth.familyId, input.operationKey],
  );
  if (replay.rowCount) return null;

  // Subject-bound explicit claims reach the writer with an opaque ref that is resolved inside the
  // write transaction. Do not compare them as subjectless before that verified identity exists;
  // exact reinforcement still runs after resolution in the single writer transaction.
  if (input.explicitSource?.subjectRef !== undefined ||
    input.explicitSource?.subjectLabel !== undefined) return null;

  const scopePartitionKey = partition(auth, input);
  const contentNormalized = normalizeMemoryClaimContent(input.content);
  // Subjectless explicit claims compare only with other subjectless claims in the same trust zone.
  const subjectUserId = null;
  const candidates = await database().query<ExistingRow>(
    `SELECT item.id, 'existing_' || encode(gen_random_bytes(16), 'hex') AS candidate_ref,
            item.content, item.kind::text, similarity(item.content_normalized, $4) AS similarity,
            CASE WHEN evidence.evidence_kind IS NOT NULL THEN evidence.evidence_kind::text
                 ELSE 'explicit' END AS evidence_kind,
            CASE WHEN item.author_user_id IS NOT NULL THEN 'user:' || item.author_user_id::text
                 WHEN item.author_telegram_user_id IS NOT NULL
                   THEN 'telegram:' || item.author_telegram_user_id ELSE NULL END AS author_ref
     FROM memory_items AS item
     LEFT JOIN LATERAL (
       SELECT evidence_kind, author_user_id, author_participant_id FROM claim_evidence
       WHERE claim_id = item.id AND evidence_role = 'primary' ORDER BY observed_at, id LIMIT 1
     ) AS evidence ON true
     WHERE item.family_id = $1 AND item.scope = $2 AND item.scope_partition_key = $3
       AND item.claim_status = 'active' AND item.content_normalized IS NOT NULL
       AND item.subject_user_id IS NOT DISTINCT FROM $5::uuid
       AND item.subject_participant_id IS NULL AND item.subject_label IS NULL
       AND (item.content_normalized = $4 OR item.content_normalized % $4)
     ORDER BY (item.content_normalized = $4) DESC, similarity DESC, item.updated_at DESC, item.id
     LIMIT $6`,
    [auth.familyId, input.scope, scopePartitionKey, contentNormalized, subjectUserId,
      MEMORY_CONSOLIDATION_CANDIDATE_LIMIT],
  );
  if (candidates.rows[0] && candidates.rows[0].similarity === 1) return null;
  const similar = candidates.rows.filter((candidate) =>
    Number(candidate.similarity) >= MEMORY_CONSOLIDATION_MIN_TRIGRAM_SIMILARITY
  );
  if (similar.length === 0) return null;

  // The job and bounded candidate map commit before the only provider call starts.
  const leaseToken = randomUUID();
  const client = await database().connect();
  let jobId: string;
  try {
    await client.query("BEGIN");
    const job = await client.query<{ id: string }>(
      `INSERT INTO memory_consolidation_jobs
         (family_id, scope, scope_partition_key, operation_key, input_hash,
          proposed_content, proposed_kind, proposed_author_user_id,
          proposed_author_telegram_user_id, proposed_subject_user_id, status, lease_token,
          lease_expires_at, provider_call_started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'leased', $11,
               now() + ($12::text || ' milliseconds')::interval, now()) RETURNING id`,
      [auth.familyId, input.scope, scopePartitionKey, input.operationKey,
        memoryOperationHash(input), input.content, input.kind, auth.userId,
        auth.telegramUserId, subjectUserId, leaseToken,
        MEMORY_CONSOLIDATION_JOB_LEASE_MILLISECONDS],
    );
    jobId = job.rows[0]!.id;
    for (const candidate of similar) {
      await client.query(
        `INSERT INTO memory_consolidation_job_candidates
           (job_id, candidate_ref, existing_claim_id, family_id, scope,
            scope_partition_key, similarity)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [jobId, candidate.candidate_ref, candidate.id, auth.familyId, input.scope,
          scopePartitionKey, candidate.similarity],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const newRef = `new_${memoryOperationHash(input).slice(0, 32)}`;
  try {
    const decisions = await classifyMemoryRelations({
      existingCandidates: similar.map((candidate) => ({
        content: candidate.content,
        evidenceKind: candidate.evidence_kind,
        kind: candidate.kind,
        ref: candidate.candidate_ref,
      })),
      newCandidates: [{ content: input.content, evidenceKind: "explicit", kind: input.kind, ref: newRef }],
    });
    const decision = decisions[0];
    if (!decision || decisions.length !== 1) {
      throw new AppError(
        "AGENT_MEMORY_CONSOLIDATION_OUTPUT_INVALID",
        "Classifier не вернул ровно одно решение explicit memory",
      );
    }
    const target = decision.existingRef
      ? similar.find((candidate) => candidate.candidate_ref === decision.existingRef)
      : undefined;
    const guarded = target
      ? guardConsolidationDecision({
          existing: {
            authorRef: target.author_ref,
            content: target.content,
            evidenceKind: target.evidence_kind,
            kind: target.kind,
            subjectRef: subjectUserId ? `user:${subjectUserId}` : "subjectless",
          },
          proposed: {
            authorRef: authorRef(auth),
            content: input.content,
            evidenceKind: "explicit",
            kind: input.kind,
            subjectRef: subjectUserId ? `user:${subjectUserId}` : "subjectless",
          },
          relation: decision.relation,
        })
      : decision.relation === "new"
        ? { action: "new" as const }
        : { action: "ambiguous" as const, reason: "Relation не имеет existing ref" };
    if (guarded.action === "ambiguous") {
      await database().query(
        `UPDATE memory_consolidation_jobs SET status = 'ambiguous', output_payload_hash = $3,
                lease_token = NULL, lease_expires_at = NULL, completed_at = now(), updated_at = now()
         WHERE id = $1 AND lease_token = $2`,
        [jobId, leaseToken, memoryOperationHash({ decision, guarded })],
      );
      throw new AppError(
        "AGENT_MEMORY_CONSOLIDATION_AMBIGUOUS",
        "Похожая память найдена, но безопасно определить отношение не удалось. Уточните решение",
      );
    }
    const relation = guarded.action === "supersede" ? guarded.relation : guarded.action;
    await database().query(
      `UPDATE memory_consolidation_jobs
       SET status = $3, selected_existing_claim_id = $4, output_payload_hash = $5,
           lease_token = NULL, lease_expires_at = NULL, completed_at = now(), updated_at = now()
       WHERE id = $1 AND lease_token = $2`,
      [jobId, leaseToken, relation, target?.id ?? null,
        memoryOperationHash({ decision, guarded })],
    );
    return { relation, targetClaimId: target?.id ?? null };
  } catch (error) {
    if (error instanceof AppError && error.code === "AGENT_MEMORY_CONSOLIDATION_AMBIGUOUS") throw error;
    await database().query(
      `UPDATE memory_consolidation_jobs
       SET status = 'failed', diagnostic_code = $3, lease_token = NULL, lease_expires_at = NULL,
           completed_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'leased' AND lease_token = $2`,
      [jobId, leaseToken, stableCode(error)],
    );
    throw error;
  }
}
