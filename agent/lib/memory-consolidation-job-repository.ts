/**
 * Durable same-scope/same-subject semantic consolidation jobs.
 *
 * Exports:
 * - `ConsolidationStageResult` and `LeasedMemoryConsolidationJob` lifecycle contracts.
 * - `memoryConsolidationJobRepository`: stages candidates, leases one pass, and commits terminal output.
 * - Verified record loading and hashing are delegated to `memory-consolidation-job-records.ts`.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import {
  guardConsolidationDecision,
} from "./memory-consolidation-guards.js";
import {
  type CandidateIdentityRow,
  type ExistingCandidateRow,
  loadCandidateIdentity,
  payloadHash,
  subjectRef,
} from "./memory-consolidation-job-records.js";
import {
  MEMORY_CONSOLIDATION_CANDIDATE_LIMIT,
  MEMORY_CONSOLIDATION_JOB_LEASE_MILLISECONDS,
  MEMORY_CONSOLIDATION_MIN_TRIGRAM_SIMILARITY,
} from "./memory-config.js";
import type {
  MemoryRelationCandidate,
  MemoryRelationDecision,
} from "./memory-relation-classifier.js";
import { normalizeMemoryClaimContent } from "./memory-record.js";

export type ConsolidationStageResult = "exact" | "none" | "pending" | "ready";

export interface LeasedMemoryConsolidationJob {
  id: string;
  leaseToken: string;
}

export const memoryConsolidationJobRepository = {
  async stageCandidate(candidateRowId: string): Promise<ConsolidationStageResult> {
    const candidate = await loadCandidateIdentity(candidateRowId);
    const completed = await database().query(
      `SELECT 1 FROM memory_consolidation_jobs
       WHERE candidate_row_id = $1
         AND status IN ('new', 'duplicate', 'refinement', 'temporal_update', 'correction', 'conflict')
       ORDER BY attempt DESC LIMIT 1`,
      [candidateRowId],
    );
    // A terminal semantic decision is consumed by the single claim writer; it is not a new attempt.
    if (completed.rowCount) return "ready";
    const normalized = normalizeMemoryClaimContent(candidate.content);
    const existing = await database().query<{ exact: boolean; id: string; similarity: number }>(
      `SELECT item.id, item.content_normalized = $4 AS exact,
              similarity(item.content_normalized, $4) AS similarity
       FROM memory_items AS item
       WHERE item.family_id = $1 AND item.scope = $2 AND item.scope_partition_key = $3
         AND item.claim_status = 'active' AND item.content_normalized IS NOT NULL
         AND item.subject_user_id IS NOT DISTINCT FROM $5::uuid
         AND item.subject_participant_id IS NOT DISTINCT FROM $6::uuid
         AND item.subject_label IS NOT DISTINCT FROM $7::text
         AND (item.content_normalized = $4 OR item.content_normalized % $4)
       ORDER BY exact DESC, similarity DESC, item.updated_at DESC, item.id
       LIMIT $8`,
      [candidate.family_id, candidate.scope, candidate.scope_partition_key, normalized,
        candidate.subject_user_id, candidate.subject_participant_id, candidate.subject_label,
        MEMORY_CONSOLIDATION_CANDIDATE_LIMIT],
    );
    if (existing.rows[0]?.exact) return "exact";
    const similar = existing.rows.filter((row) =>
      Number(row.similarity) >= MEMORY_CONSOLIDATION_MIN_TRIGRAM_SIMILARITY
    );
    if (similar.length === 0) return "none";

    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(
         `SELECT 1 FROM memory_extraction_candidates
          WHERE id = $1 AND resolution_status = 'resolution_processing' FOR UPDATE`,
        [candidateRowId],
      );
      if (!locked.rowCount) {
        throw new AppError(
          "AGENT_MEMORY_CONSOLIDATION_CANDIDATE_INVALID",
          "Кандидат consolidation уже обрабатывается",
        );
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO memory_consolidation_jobs
           (candidate_row_id, family_id, scope, scope_partition_key, operation_key, input_hash)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [candidateRowId, candidate.family_id, candidate.scope, candidate.scope_partition_key,
          candidate.operation_key, payloadHash({ candidate: candidate.candidate_id, similar })],
      );
      for (const item of similar) {
        await client.query(
          `INSERT INTO memory_consolidation_job_candidates
             (job_id, candidate_ref, existing_claim_id, family_id, scope,
              scope_partition_key, similarity)
           VALUES ($1, 'existing_' || encode(gen_random_bytes(16), 'hex'), $2, $3, $4, $5, $6)`,
          [inserted.rows[0]!.id, item.id, candidate.family_id, candidate.scope,
            candidate.scope_partition_key, item.similarity],
        );
      }
      await client.query(
        `UPDATE memory_extraction_candidates SET resolution_status = 'consolidation_pending',
                 resolution_lease_token = NULL, resolution_lease_expires_at = NULL
         WHERE id = $1`,
        [candidateRowId],
      );
      await client.query("COMMIT");
      return "pending";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async claimPending(): Promise<LeasedMemoryConsolidationJob | null> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      // An expired provider-capable lease is terminal. The extraction candidate remains durable.
      await client.query(
        `UPDATE memory_consolidation_jobs
         SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
             diagnostic_code = 'AGENT_MEMORY_CONSOLIDATION_LEASE_EXPIRED',
             completed_at = now(), updated_at = now()
         WHERE status = 'leased' AND lease_expires_at < now()`,
      );
      const result = await client.query<{ id: string; lease_token: string }>(
        `WITH next AS (
           SELECT id FROM memory_consolidation_jobs WHERE status = 'pending'
           ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE memory_consolidation_jobs AS job
         SET status = 'leased', lease_token = gen_random_uuid(),
             lease_expires_at = now() + ($1::text || ' milliseconds')::interval,
             updated_at = now()
         FROM next WHERE job.id = next.id RETURNING job.id, job.lease_token::text`,
        [MEMORY_CONSOLIDATION_JOB_LEASE_MILLISECONDS],
      );
      await client.query("COMMIT");
      const job = result.rows[0];
      return job ? { id: job.id, leaseToken: job.lease_token } : null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async markProviderCallStarted(jobId: string, leaseToken: string): Promise<void> {
    const result = await database().query(
      `UPDATE memory_consolidation_jobs
       SET provider_call_started_at = coalesce(provider_call_started_at, now()), updated_at = now()
       WHERE id = $1 AND status = 'leased' AND lease_token = $2 AND lease_expires_at > now()`,
      [jobId, leaseToken],
    );
    if (!result.rowCount) {
      throw new AppError("AGENT_MEMORY_CONSOLIDATION_JOB_STALE", "Задача consolidation уже не арендована");
    }
  },

  async loadClassifierInput(jobId: string): Promise<{
    existingCandidates: MemoryRelationCandidate[];
    newCandidates: MemoryRelationCandidate[];
  }> {
    const proposed = await database().query<CandidateIdentityRow>(
      `SELECT candidate.candidate_id, candidate.operation_key, candidate.content,
              candidate.kind::text, candidate.evidence_kind, batch.family_id, batch.scope,
              batch.scope_partition_key, candidate.subject_label,
              CASE WHEN batch.scope = 'group' THEN subject.id ELSE NULL END AS subject_participant_id,
              CASE WHEN batch.scope <> 'group' THEN subject.linked_user_id ELSE NULL END AS subject_user_id,
              CASE WHEN author.linked_user_id IS NOT NULL THEN 'user:' || author.linked_user_id::text
                   ELSE 'telegram:' || author.telegram_user_id END AS author_ref
       FROM memory_consolidation_jobs AS job
       JOIN memory_extraction_candidates AS candidate ON candidate.id = job.candidate_row_id
       JOIN memory_extraction_batches AS batch ON batch.id = candidate.batch_id
       JOIN memory_extraction_candidate_sources AS source
         ON source.candidate_row_id = candidate.id AND source.source_role = 'primary'
       JOIN memory_extraction_snapshot_entries AS snapshot ON snapshot.id = source.snapshot_entry_id
       JOIN conversation_participants AS author ON author.id = snapshot.author_participant_id
       LEFT JOIN conversation_participants AS subject
         ON subject.conversation_id = batch.conversation_id
        AND subject.participant_ref = candidate.subject_participant_ref
       WHERE job.id = $1 AND job.status = 'leased'`,
      [jobId],
    );
    const current = proposed.rows[0];
    if (!current) {
      throw new AppError("AGENT_MEMORY_CONSOLIDATION_JOB_STALE", "Задача consolidation недоступна");
    }
    const existing = await database().query<ExistingCandidateRow>(
      `SELECT mapped.candidate_ref, item.id, item.content, item.kind::text,
              CASE WHEN evidence.evidence_kind IS NOT NULL THEN evidence.evidence_kind::text
                   ELSE 'explicit' END AS evidence_kind,
              CASE WHEN item.author_user_id IS NOT NULL THEN 'user:' || item.author_user_id::text
                   WHEN item.author_telegram_user_id IS NOT NULL
                     THEN 'telegram:' || item.author_telegram_user_id ELSE NULL END AS author_ref
       FROM memory_consolidation_job_candidates AS mapped
       JOIN memory_items AS item ON item.id = mapped.existing_claim_id
       LEFT JOIN LATERAL (
         SELECT evidence_kind, author_user_id, author_participant_id
         FROM claim_evidence WHERE claim_id = item.id AND evidence_role = 'primary' LIMIT 1
       ) AS evidence ON true
       WHERE mapped.job_id = $1 ORDER BY mapped.similarity DESC, mapped.candidate_ref`,
      [jobId],
    );
    return {
      existingCandidates: existing.rows.map((row) => ({
        content: row.content,
        evidenceKind: row.evidence_kind,
        kind: row.kind,
        ref: row.candidate_ref,
      })),
      newCandidates: [{
        content: current.content,
        evidenceKind: current.evidence_kind,
        kind: current.kind,
        ref: `new_${current.candidate_id.slice(5, 37)}`,
      }],
    };
  },

  async complete(jobId: string, leaseToken: string, decision: MemoryRelationDecision): Promise<void> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const job = await client.query<CandidateIdentityRow & { candidate_row_id: string }>(
        `SELECT job.candidate_row_id, candidate.candidate_id, candidate.operation_key,
                candidate.content, candidate.kind::text, candidate.evidence_kind,
                batch.family_id, batch.scope, batch.scope_partition_key, candidate.subject_label,
                CASE WHEN batch.scope = 'group' THEN subject.id ELSE NULL END AS subject_participant_id,
                CASE WHEN batch.scope <> 'group' THEN subject.linked_user_id ELSE NULL END AS subject_user_id,
                CASE WHEN author.linked_user_id IS NOT NULL THEN 'user:' || author.linked_user_id::text
                     ELSE 'telegram:' || author.telegram_user_id END AS author_ref
         FROM memory_consolidation_jobs AS job
         JOIN memory_extraction_candidates AS candidate ON candidate.id = job.candidate_row_id
         JOIN memory_extraction_batches AS batch ON batch.id = candidate.batch_id
         JOIN memory_extraction_candidate_sources AS source
           ON source.candidate_row_id = candidate.id AND source.source_role = 'primary'
         JOIN memory_extraction_snapshot_entries AS snapshot ON snapshot.id = source.snapshot_entry_id
         JOIN conversation_participants AS author ON author.id = snapshot.author_participant_id
         LEFT JOIN conversation_participants AS subject
           ON subject.conversation_id = batch.conversation_id
          AND subject.participant_ref = candidate.subject_participant_ref
         WHERE job.id = $1 AND job.status = 'leased' AND job.lease_token = $2
           AND job.lease_expires_at > now() AND job.provider_call_started_at IS NOT NULL
         FOR UPDATE OF job, candidate`,
        [jobId, leaseToken],
      );
      const proposed = job.rows[0];
      if (!proposed) {
        throw new AppError("AGENT_MEMORY_CONSOLIDATION_JOB_STALE", "Lease consolidation устарел");
      }
      const expectedNewRef = `new_${proposed.candidate_id.slice(5, 37)}`;
      if (decision.newRef !== expectedNewRef) {
        throw new AppError(
          "AGENT_MEMORY_CONSOLIDATION_OUTPUT_INVALID",
          "Решение consolidation относится к другому candidate ref",
        );
      }

      const existing = decision.existingRef
        ? await client.query<ExistingCandidateRow & {
            subject_label: string | null;
            subject_participant_id: string | null;
            subject_user_id: string | null;
          }>(
            `SELECT mapped.candidate_ref, item.id, item.content, item.kind::text,
                    item.subject_label, item.subject_participant_id, item.subject_user_id,
                    CASE WHEN evidence.evidence_kind IS NOT NULL THEN evidence.evidence_kind::text
                         ELSE 'explicit' END AS evidence_kind,
                    CASE WHEN item.author_user_id IS NOT NULL THEN 'user:' || item.author_user_id::text
                         WHEN item.author_telegram_user_id IS NOT NULL
                           THEN 'telegram:' || item.author_telegram_user_id ELSE NULL END AS author_ref
             FROM memory_consolidation_job_candidates AS mapped
             JOIN memory_items AS item ON item.id = mapped.existing_claim_id
             LEFT JOIN LATERAL (
               SELECT evidence_kind, author_user_id, author_participant_id FROM claim_evidence
               WHERE claim_id = item.id AND evidence_role = 'primary' LIMIT 1
             ) AS evidence ON true
             WHERE mapped.job_id = $1 AND mapped.candidate_ref = $2 AND item.claim_status = 'active'
             FOR UPDATE OF item`,
            [jobId, decision.existingRef],
          )
        : null;
      const target = existing?.rows[0];
      if (decision.existingRef && !target) {
        throw new AppError(
          "AGENT_MEMORY_CONSOLIDATION_TARGET_STALE",
          "Связанная версия памяти изменилась до завершения consolidation",
        );
      }
      const guarded = target
        ? guardConsolidationDecision({
            existing: {
              authorRef: target.author_ref,
              content: target.content,
              evidenceKind: target.evidence_kind,
              kind: target.kind,
              subjectRef: subjectRef(target),
            },
            proposed: {
              authorRef: proposed.author_ref,
              content: proposed.content,
              evidenceKind: proposed.evidence_kind,
              kind: proposed.kind,
              subjectRef: subjectRef(proposed),
            },
            relation: decision.relation,
          })
        : decision.relation === "new"
          ? { action: "new" as const }
          : { action: "ambiguous" as const, reason: "Relation не имеет existing ref" };
      const status = guarded.action === "supersede" ? guarded.relation : guarded.action;
      const outputHash = payloadHash({ decision, guarded });
      await client.query(
        `UPDATE memory_consolidation_jobs
         SET status = $3, selected_existing_claim_id = $4, output_payload_hash = $5,
             lease_token = NULL, lease_expires_at = NULL, completed_at = now(), updated_at = now()
         WHERE id = $1 AND lease_token = $2`,
        [jobId, leaseToken, status, target?.id ?? null, outputHash],
      );
      await client.query(
        guarded.action === "ambiguous"
          ? `UPDATE memory_extraction_candidates SET resolution_status = 'ambiguous',
                   resolved_at = now() WHERE id = $1 AND resolution_status = 'consolidation_pending'`
          : `UPDATE memory_extraction_candidates SET resolution_status = 'pending'
             WHERE id = $1 AND resolution_status = 'consolidation_pending'`,
        [proposed.candidate_row_id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async fail(jobId: string, leaseToken: string, diagnosticCode: string): Promise<void> {
    const result = await database().query(
      `UPDATE memory_consolidation_jobs
       SET status = 'failed', diagnostic_code = $3, lease_token = NULL, lease_expires_at = NULL,
           completed_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'leased' AND lease_token = $2`,
      [jobId, leaseToken, diagnosticCode],
    );
    if (!result.rowCount) {
      throw new AppError("AGENT_MEMORY_CONSOLIDATION_JOB_STALE", "Ошибка относится к устаревшему lease");
    }
  },

  async requeueFailed(jobId: string): Promise<{ attempt: number; jobId: string }> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const failed = await client.query<{
        attempt: number;
        candidate_row_id: string;
        family_id: string;
        input_hash: string;
        operation_key: string;
        scope: "family" | "group" | "personal";
        scope_partition_key: string;
      }>(
        `SELECT candidate_row_id, attempt, family_id, scope, scope_partition_key,
                operation_key, input_hash
         FROM memory_consolidation_jobs WHERE id = $1 AND status = 'failed' FOR UPDATE`,
        [jobId],
      );
      const previous = failed.rows[0];
      if (!previous) {
        throw new AppError(
          "AGENT_MEMORY_CONSOLIDATION_REQUEUE_INVALID",
          "Явная повторная попытка разрешена только после terminal provider failure",
        );
      }
      const attempt = previous.attempt + 1;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO memory_consolidation_jobs
           (candidate_row_id, attempt, family_id, scope, scope_partition_key,
            operation_key, input_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [previous.candidate_row_id, attempt, previous.family_id, previous.scope,
          previous.scope_partition_key, `${previous.operation_key}:attempt:${attempt}`,
          previous.input_hash],
      );
      await client.query(
        `INSERT INTO memory_consolidation_job_candidates
           (job_id, candidate_ref, existing_claim_id, family_id, scope,
            scope_partition_key, similarity)
         SELECT $2, 'existing_' || encode(gen_random_bytes(16), 'hex'), existing_claim_id,
                family_id, scope, scope_partition_key, similarity
         FROM memory_consolidation_job_candidates WHERE job_id = $1`,
        [jobId, inserted.rows[0]!.id],
      );
      await client.query("COMMIT");
      return { attempt, jobId: inserted.rows[0]!.id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
