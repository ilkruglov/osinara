/**
 * Durable online/recovery memory-thread discovery job repository.
 *
 * Exports:
 * - `memoryThreadDiscoveryRepository`: stages candidates, leases one classifier pass, and commits terminal state.
 */
import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import { database } from "./database.js";
import {
  MEMORY_EMBEDDING_MODEL_VERSION,
  THREAD_DISCOVERY_CANDIDATE_LIMIT,
  THREAD_DISCOVERY_JOB_LEASE_MILLISECONDS,
  THREAD_DISCOVERY_LOOKBACK_DAYS,
  THREAD_DISCOVERY_MAX_OPERATOR_ATTEMPTS,
  THREAD_TITLE_MIN_SEMANTIC_SIMILARITY,
} from "./memory-config.js";
import type { MemoryThreadClassifierInput, MemoryThreadDecision } from "./memory-thread-classifier.js";
import { commitMemoryThreadDecision } from "./memory-thread-coordinator.js";
import { evaluateImmediateThreadGate, evaluateRecoveryThreadGate } from "./memory-thread-discovery-policy.js";

interface CandidateClaimRow {
  batch_id: string | null;
  evidenced: boolean;
  family_id: string;
  id: string;
  memory_project_id: string | null;
  observed_at: Date;
  scope: "family" | "group" | "personal";
  scope_partition_key: string;
  subject_conversation_id: string | null;
  subject_participant_id: string | null;
  subject_user_id: string | null;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function opaqueBatchRef(batchId: string | null): string | null {
  return batchId === null ? null : `batch_${hash(batchId).slice(0, 32)}`;
}

function identityRef(row: CandidateClaimRow): { projectRef: string | null; subjectRef: string | null } {
  return {
    projectRef: row.memory_project_id === null ? null : `project_${hash(row.memory_project_id).slice(0, 32)}`,
    subjectRef: row.subject_user_id
      ? `subject_${hash(row.subject_user_id).slice(0, 32)}`
      : row.subject_participant_id
        ? `subject_${hash(row.subject_participant_id).slice(0, 32)}`
        : null,
  };
}

async function stageRows(
  client: PoolClient,
  rows: readonly CandidateClaimRow[],
  path: "online" | "recovery",
  ongoingFutureWork: boolean,
): Promise<string> {
  const first = rows[0]!;
  const claimIds = rows.map((row) => row.id).sort();
  const candidateKey = hash({ claimIds, path: "memory-thread" });
  const inputHash = hash({ claimIds, ongoingFutureWork, path });
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO memory_thread_discovery_jobs
       (family_id, scope, scope_partition_key, subject_user_id, subject_participant_id,
        subject_conversation_id, memory_project_id, discovery_path, candidate_key, input_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (family_id, candidate_key, attempt) DO NOTHING RETURNING id`,
    [first.family_id, first.scope, first.scope_partition_key, first.subject_user_id,
      first.subject_participant_id, first.subject_conversation_id, first.memory_project_id,
      path, candidateKey, inputHash],
  );
  let jobId = inserted.rows[0]?.id;
  if (!jobId) {
    const existing = await client.query<{ id: string; input_hash: string }>(
      `SELECT id, input_hash FROM memory_thread_discovery_jobs
       WHERE family_id = $1 AND candidate_key = $2 AND attempt = 1`,
      [first.family_id, candidateKey],
    );
    if (!existing.rows[0] || existing.rows[0].input_hash !== inputHash) {
      throw new AppError(
        "AGENT_MEMORY_THREAD_DISCOVERY_REPLAY_MISMATCH",
        "Повтор кандидата нити не совпадает с исходными источниками",
      );
    }
    return existing.rows[0].id;
  }
  for (const row of rows) {
    await client.query(
      `INSERT INTO memory_thread_discovery_sources
         (job_id, source_claim_id, family_id, scope, scope_partition_key,
          extraction_batch_id, ongoing_future_work)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [jobId, row.id, row.family_id, row.scope, row.scope_partition_key,
        row.batch_id, ongoingFutureWork],
    );
  }
  await client.query(
    `INSERT INTO memory_thread_discovery_existing
       (job_id, thread_candidate_ref, thread_id, is_parent_candidate)
     SELECT $1, 'thread_' || encode(gen_random_bytes(16), 'hex'), thread.id,
            thread.parent_thread_id IS NULL
     FROM memory_threads AS thread
     WHERE thread.family_id = $2 AND thread.scope = $3 AND thread.scope_partition_key = $4
       AND ((thread.subject_user_id IS NOT DISTINCT FROM $5::uuid
         AND thread.subject_participant_id IS NOT DISTINCT FROM $6::uuid
         AND thread.memory_project_id IS NOT DISTINCT FROM $7::uuid) OR
        ($5::uuid IS NULL AND $6::uuid IS NULL AND $7::uuid IS NULL
          AND thread.subject_user_id IS NULL AND thread.subject_participant_id IS NULL
          AND thread.memory_project_id IS NOT NULL))
       AND thread.status = 'active'`,
    [jobId, first.family_id, first.scope, first.scope_partition_key, first.subject_user_id,
      first.subject_participant_id, first.memory_project_id],
  );
  return jobId;
}

async function loadClaim(claimId: string): Promise<CandidateClaimRow | null> {
  const result = await database().query<CandidateClaimRow>(
    `SELECT item.id, item.family_id, item.scope, item.scope_partition_key,
            item.subject_user_id, item.subject_participant_id, item.subject_conversation_id,
            item.memory_project_id, item.provenance_state = 'evidenced' AS evidenced,
            evidence.observed_at, candidate.batch_id
     FROM memory_items AS item
     JOIN LATERAL (
       SELECT observed_at FROM claim_evidence
       WHERE claim_id = item.id AND evidence_role = 'primary' LIMIT 1
     ) AS evidence ON true
     LEFT JOIN memory_extraction_candidates AS candidate ON candidate.resolved_claim_id = item.id
     WHERE item.id = $1 AND item.claim_status = 'active'`,
    [claimId],
  );
  return result.rows[0] ?? null;
}

export const memoryThreadDiscoveryRepository = {
  async stageNextImmediateCandidate(): Promise<boolean> {
    const pending = await database().query<{ id: string }>(
      `SELECT candidate.resolved_claim_id AS id
       FROM memory_extraction_candidates AS candidate
       LEFT JOIN memory_thread_discovery_sources AS source
         ON source.source_claim_id = candidate.resolved_claim_id
       WHERE candidate.resolution_status IN ('claim_created', 'reinforced')
         AND candidate.proposed_thread_continuation = true
         AND candidate.resolved_claim_id IS NOT NULL AND source.source_claim_id IS NULL
       ORDER BY candidate.resolved_at, candidate.id LIMIT 1`,
    );
    const claimId = pending.rows[0]?.id;
    if (!claimId) return false;
    await memoryThreadDiscoveryRepository.stageImmediateCandidate(claimId, true);
    return true;
  },

  async stageImmediateCandidate(claimId: string, ongoingFutureWork: boolean): Promise<boolean> {
    const claim = await loadClaim(claimId);
    if (!claim || !evaluateImmediateThreadGate({ evidenced: claim.evidenced, ongoingFutureWork }).eligible) {
      return false;
    }
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await stageRows(client, [claim], "online", true);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async stageRecoveryCandidate(): Promise<boolean> {
    const seed = await database().query<CandidateClaimRow>(
      `SELECT item.id, item.family_id, item.scope, item.scope_partition_key,
              item.subject_user_id, item.subject_participant_id, item.subject_conversation_id,
              item.memory_project_id, true AS evidenced, evidence.observed_at, candidate.batch_id
       FROM memory_items AS item
       JOIN claim_evidence AS evidence ON evidence.claim_id = item.id AND evidence.evidence_role = 'primary'
       JOIN memory_extraction_candidates AS candidate ON candidate.resolved_claim_id = item.id
       LEFT JOIN memory_thread_discovery_claim_coverage AS coverage ON coverage.source_claim_id = item.id
       WHERE coverage.source_claim_id IS NULL AND item.claim_status = 'active'
         AND item.provenance_state = 'evidenced' AND item.embedding_status = 'indexed'
       ORDER BY evidence.observed_at, item.id LIMIT 1`,
    );
    const first = seed.rows[0];
    if (!first) return false;
    const cluster = await database().query<CandidateClaimRow>(
      `SELECT DISTINCT item.id, item.family_id, item.scope, item.scope_partition_key,
              item.subject_user_id, item.subject_participant_id, item.subject_conversation_id,
              item.memory_project_id, true AS evidenced, evidence.observed_at, candidate.batch_id
       FROM memory_items AS seed
       JOIN memory_items AS item ON item.family_id = seed.family_id AND item.scope = seed.scope
        AND item.scope_partition_key = seed.scope_partition_key
        AND item.subject_user_id IS NOT DISTINCT FROM seed.subject_user_id
        AND item.subject_participant_id IS NOT DISTINCT FROM seed.subject_participant_id
        AND item.memory_project_id IS NOT DISTINCT FROM seed.memory_project_id
       JOIN claim_evidence AS evidence ON evidence.claim_id = item.id AND evidence.evidence_role = 'primary'
       JOIN memory_extraction_candidates AS candidate ON candidate.resolved_claim_id = item.id
       WHERE seed.id = $1 AND item.claim_status = 'active' AND item.provenance_state = 'evidenced'
         AND item.embedding_status = 'indexed'
         AND evidence.observed_at >= now() - ($2::text || ' days')::interval
         AND (item.id = seed.id OR item.content_normalized % seed.content_normalized OR EXISTS (
           SELECT 1 FROM memory_embedding_chunks AS seed_chunk
           JOIN memory_embedding_chunks AS item_chunk ON item_chunk.memory_item_id = item.id
           WHERE seed_chunk.memory_item_id = seed.id
             AND seed_chunk.embedding_model = $3 AND item_chunk.embedding_model = $3
             AND 1 - (seed_chunk.embedding <=> item_chunk.embedding) >= $4
         ))
       ORDER BY evidence.observed_at DESC, item.id
       LIMIT $5`,
      [first.id, THREAD_DISCOVERY_LOOKBACK_DAYS, MEMORY_EMBEDDING_MODEL_VERSION,
        THREAD_TITLE_MIN_SEMANTIC_SIMILARITY, THREAD_DISCOVERY_CANDIDATE_LIMIT],
    );
    const gate = evaluateRecoveryThreadGate(cluster.rows.map((row) => ({
      batchRef: opaqueBatchRef(row.batch_id)!,
      evidenced: row.evidenced,
      observedAt: row.observed_at.toISOString(),
      ...identityRef(row),
      scope: row.scope,
      sourceRef: `source_${hash(row.id).slice(0, 32)}`,
    })), new Date());
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      let jobId: string | null = null;
      if (gate.eligible) jobId = await stageRows(client, cluster.rows, "recovery", false);
      const consideredClaimIds = cluster.rows.length > 0
        ? cluster.rows.map((row) => row.id)
        : [first.id];
      await client.query(
        `INSERT INTO memory_thread_discovery_claim_coverage (source_claim_id, last_job_id)
         SELECT source_claim_id, $2 FROM unnest($1::uuid[]) AS source_claim_id
         ON CONFLICT (source_claim_id) DO UPDATE
         SET last_job_id = EXCLUDED.last_job_id, considered_at = now()`,
        [consideredClaimIds, jobId],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async claimPending(): Promise<{ id: string; leaseToken: string } | null> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE memory_thread_discovery_jobs
         SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
             diagnostic_code = 'AGENT_MEMORY_THREAD_DISCOVERY_LEASE_EXPIRED',
             completed_at = now(), updated_at = now()
         WHERE status = 'leased' AND lease_expires_at < now()`,
      );
      const result = await client.query<{ id: string; lease_token: string }>(
        `WITH next AS (
           SELECT id FROM memory_thread_discovery_jobs WHERE status = 'pending'
           ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE memory_thread_discovery_jobs AS job
         SET status = 'leased', lease_token = gen_random_uuid(),
             lease_expires_at = now() + ($1::text || ' milliseconds')::interval,
             updated_at = now()
         FROM next WHERE job.id = next.id RETURNING job.id, job.lease_token::text`,
        [THREAD_DISCOVERY_JOB_LEASE_MILLISECONDS],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      return row ? { id: row.id, leaseToken: row.lease_token } : null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async markProviderCallStarted(jobId: string, leaseToken: string): Promise<void> {
    const result = await database().query(
      `UPDATE memory_thread_discovery_jobs
       SET provider_call_started_at = coalesce(provider_call_started_at, now()), updated_at = now()
       WHERE id = $1 AND status = 'leased' AND lease_token = $2 AND lease_expires_at > now()`,
      [jobId, leaseToken],
    );
    if (!result.rowCount) {
      throw new AppError("AGENT_MEMORY_THREAD_DISCOVERY_JOB_STALE", "Задача поиска нити уже не арендована");
    }
  },

  async loadClassifierInput(jobId: string): Promise<MemoryThreadClassifierInput> {
    const sources = await database().query<{
      batch_id: string | null;
      content: string;
      kind: MemoryThreadClassifierInput["sources"][number]["kind"];
      source_ref: string;
    }>(
      `SELECT source.source_ref, source.extraction_batch_id AS batch_id, item.content, item.kind::text
       FROM memory_thread_discovery_sources AS source
       JOIN memory_items AS item ON item.id = source.source_claim_id
       JOIN memory_thread_discovery_jobs AS job ON job.id = source.job_id
       WHERE source.job_id = $1 AND job.status = 'leased' ORDER BY source.source_ref`,
      [jobId],
    );
    const threads = await database().query<{
      is_parent_candidate: boolean;
      purpose: string;
      ref: string;
      title: string;
    }>(
      `SELECT candidate.thread_candidate_ref AS ref, candidate.is_parent_candidate,
              thread.title, thread.purpose
       FROM memory_thread_discovery_existing AS candidate
       JOIN memory_threads AS thread ON thread.id = candidate.thread_id
       WHERE candidate.job_id = $1 AND thread.status = 'active'
       ORDER BY candidate.thread_candidate_ref`,
      [jobId],
    );
    return {
      existingThreads: threads.rows.map(({ is_parent_candidate: _parent, ...thread }) => thread),
      parentCandidates: threads.rows.filter((thread) => thread.is_parent_candidate)
        .map(({ is_parent_candidate: _parent, ...thread }) => thread),
      sources: sources.rows.map((source) => ({
        batchRef: opaqueBatchRef(source.batch_id),
        content: source.content,
        kind: source.kind,
        ref: source.source_ref,
      })),
    };
  },

  complete: commitMemoryThreadDecision,

  async fail(jobId: string, leaseToken: string, diagnosticCode: string): Promise<void> {
    const result = await database().query(
      `UPDATE memory_thread_discovery_jobs
       SET status = 'failed', diagnostic_code = $3, lease_token = NULL, lease_expires_at = NULL,
           completed_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'leased' AND lease_token = $2`,
      [jobId, leaseToken, diagnosticCode],
    );
    if (!result.rowCount) {
      throw new AppError("AGENT_MEMORY_THREAD_DISCOVERY_JOB_STALE", "Ошибка относится к устаревшему lease");
    }
  },

  async requeueFailed(jobId: string): Promise<{ attempt: number; jobId: string }> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const failed = await client.query<{
        attempt: number;
        candidate_key: string;
        discovery_path: "online" | "recovery";
        family_id: string;
        input_hash: string;
        memory_project_id: string | null;
        scope: "family" | "group" | "personal";
        scope_partition_key: string;
        subject_conversation_id: string | null;
        subject_participant_id: string | null;
        subject_user_id: string | null;
      }>(
        `SELECT attempt, candidate_key, discovery_path, family_id, input_hash, scope,
                scope_partition_key, subject_user_id, subject_participant_id,
                subject_conversation_id, memory_project_id
         FROM memory_thread_discovery_jobs WHERE id = $1 AND status = 'failed' FOR UPDATE`,
        [jobId],
      );
      const previous = failed.rows[0];
      if (!previous || previous.attempt >= THREAD_DISCOVERY_MAX_OPERATOR_ATTEMPTS) {
        throw new AppError(
          "AGENT_MEMORY_THREAD_DISCOVERY_REQUEUE_INVALID",
          "Явная повторная попытка недоступна или исчерпала лимит",
        );
      }
      const attempt = previous.attempt + 1;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO memory_thread_discovery_jobs
           (family_id, scope, scope_partition_key, subject_user_id, subject_participant_id,
            subject_conversation_id, memory_project_id, discovery_path, candidate_key,
            input_hash, attempt)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [previous.family_id, previous.scope, previous.scope_partition_key,
          previous.subject_user_id, previous.subject_participant_id,
          previous.subject_conversation_id, previous.memory_project_id,
          previous.discovery_path, previous.candidate_key, previous.input_hash, attempt],
      );
      const nextJobId = inserted.rows[0]!.id;
      await client.query(
        `INSERT INTO memory_thread_discovery_sources
           (job_id, source_ref, source_claim_id, family_id, scope, scope_partition_key,
            extraction_batch_id, ongoing_future_work)
         SELECT $2, source_ref, source_claim_id, family_id, scope, scope_partition_key,
                extraction_batch_id, ongoing_future_work
         FROM memory_thread_discovery_sources WHERE job_id = $1`,
        [jobId, nextJobId],
      );
      await client.query(
        `INSERT INTO memory_thread_discovery_existing
           (job_id, thread_candidate_ref, thread_id, is_parent_candidate)
         SELECT $2, thread_candidate_ref, thread_id, is_parent_candidate
         FROM memory_thread_discovery_existing WHERE job_id = $1`,
        [jobId, nextJobId],
      );
      await client.query("COMMIT");
      return { attempt, jobId: nextJobId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
