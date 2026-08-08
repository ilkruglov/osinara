/**
 * Durable memory extraction job lifecycle and explicit operator controls.
 *
 * Exports:
 * - `memoryExtractionJobRepository`: claim, provider marker, fail, requeue, range, and erasure.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import {
  requireExtractionDiagnostic,
  type ExtractionStatus,
  type LeasedMemoryExtractionJob,
  type MemoryExtractionRange,
} from "./memory-extraction-contract.js";
import {
  MEMORY_EXTRACTION_JOB_LEASE_MILLISECONDS,
  MEMORY_EXTRACTION_MAX_OPERATOR_ATTEMPTS,
} from "./memory-config.js";

export const memoryExtractionJobRepository = {
  async claimPending(): Promise<LeasedMemoryExtractionJob | null> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");

      // An expired lease is ambiguous once external work may have started. It becomes terminally
      // failed and is never selected as pending; only an explicit operator requeue can continue it.
      const expired = await client.query<{ batch_id: string }>(
        `UPDATE memory_extraction_jobs SET status = 'failed', lease_token = NULL,
            lease_expires_at = NULL, diagnostic_code = 'AGENT_MEMORY_EXTRACTION_LEASE_EXPIRED',
            completed_at = now(), updated_at = now()
         WHERE status = 'leased' AND lease_expires_at < now() RETURNING batch_id`,
      );
      if (expired.rows.length > 0) {
        const batchIds = expired.rows.map((row) => row.batch_id);
        await client.query(
          "UPDATE memory_extraction_batches SET status = 'failed', updated_at = now() WHERE id = ANY($1::uuid[])",
          [batchIds],
        );
        await client.query(
          "UPDATE memory_extraction_ranges SET status = 'failed', updated_at = now() WHERE batch_id = ANY($1::uuid[])",
          [batchIds],
        );
      }

      const claimed = await client.query<{
        attempt: number;
        batch_id: string;
        id: string;
        lease_token: string;
      }>(
        `WITH candidate AS (
           SELECT id FROM memory_extraction_jobs WHERE status = 'pending'
           ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE memory_extraction_jobs AS job
         SET status = 'leased', lease_token = gen_random_uuid(),
             lease_expires_at = now() + ($1::text || ' milliseconds')::interval,
             updated_at = now()
         FROM candidate WHERE job.id = candidate.id
         RETURNING job.id, job.batch_id, job.attempt, job.lease_token::text`,
        [MEMORY_EXTRACTION_JOB_LEASE_MILLISECONDS],
      );
      const job = claimed.rows[0];
      if (job) {
        await client.query(
          "UPDATE memory_extraction_batches SET status = 'leased', updated_at = now() WHERE id = $1",
          [job.batch_id],
        );
        await client.query(
          "UPDATE memory_extraction_ranges SET status = 'leased', updated_at = now() WHERE batch_id = $1",
          [job.batch_id],
        );
      }
      await client.query("COMMIT");
      return job
        ? { attempt: job.attempt, batchId: job.batch_id, id: job.id, leaseToken: job.lease_token }
        : null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async markProviderCallStarted(jobId: string, leaseToken: string): Promise<void> {
    const result = await database().query(
      `UPDATE memory_extraction_jobs
       SET provider_call_started_at = coalesce(provider_call_started_at, now()), updated_at = now()
       WHERE id = $1 AND status = 'leased' AND lease_token = $2 AND lease_expires_at > now()`,
      [jobId, leaseToken],
    );
    if (!result.rowCount) {
      throw new AppError("AGENT_MEMORY_EXTRACTION_JOB_STALE", "Задача извлечения уже не арендована");
    }
  },

  async fail(jobId: string, leaseToken: string, diagnosticCode: string): Promise<void> {
    const code = requireExtractionDiagnostic(diagnosticCode);
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const failed = await client.query<{ batch_id: string }>(
        `UPDATE memory_extraction_jobs SET status = 'failed', lease_token = NULL,
                lease_expires_at = NULL, diagnostic_code = $3, completed_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'leased' AND lease_token = $2 RETURNING batch_id`,
        [jobId, leaseToken, code],
      );
      const batchId = failed.rows[0]?.batch_id;
      if (!batchId) {
        throw new AppError("AGENT_MEMORY_EXTRACTION_JOB_STALE", "Ошибка относится к устаревшему lease");
      }
      await client.query(
        "UPDATE memory_extraction_batches SET status = 'failed', updated_at = now() WHERE id = $1",
        [batchId],
      );
      await client.query(
        "UPDATE memory_extraction_ranges SET status = 'failed', updated_at = now() WHERE batch_id = $1",
        [batchId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async requeue(
    batchId: string,
    mode: "new_attempt" | "safe_reset",
  ): Promise<{ attempt: number; jobId: string }> {
    if (mode !== "new_attempt" && mode !== "safe_reset") {
      throw new AppError(
        "AGENT_MEMORY_EXTRACTION_REQUEUE_INVALID",
        "Неизвестный режим повторной постановки задачи",
      );
    }
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const batches = await client.query<{ snapshot_erased_at: Date | null }>(
        "SELECT snapshot_erased_at FROM memory_extraction_batches WHERE id = $1 FOR UPDATE",
        [batchId],
      );
      const batch = batches.rows[0];
      if (!batch) {
        throw new AppError("AGENT_MEMORY_EXTRACTION_BATCH_NOT_FOUND", "Пакет извлечения не найден");
      }
      if (batch.snapshot_erased_at !== null) {
        throw new AppError(
          "AGENT_MEMORY_EXTRACTION_SNAPSHOT_ERASED",
          "Удалённый снимок нельзя повторно поставить в обработку",
        );
      }
      const latest = await client.query<{
        attempt: number;
        id: string;
        provider_call_started_at: Date | null;
        status: ExtractionStatus;
      }>(
        `SELECT id, attempt, status, provider_call_started_at FROM memory_extraction_jobs
         WHERE batch_id = $1 ORDER BY attempt DESC LIMIT 1 FOR UPDATE`,
        [batchId],
      );
      const job = latest.rows[0];
      if (!job || job.status !== "failed") {
        throw new AppError(
          "AGENT_MEMORY_EXTRACTION_REQUEUE_INVALID",
          "Повторная постановка разрешена только для завершившейся ошибкой задачи",
        );
      }

      // A call that provably never reached the provider may reuse its attempt. Any started or
      // ambiguous provider call requires a new durable attempt so diagnostics are never overwritten.
      let result: { attempt: number; jobId: string };
      if (mode === "safe_reset") {
        if (job.provider_call_started_at !== null) {
          throw new AppError(
            "AGENT_MEMORY_EXTRACTION_REQUEUE_UNSAFE",
            "Provider call уже начинался; требуется новый явный attempt",
          );
        }
        await client.query(
          `UPDATE memory_extraction_jobs SET status = 'pending', diagnostic_code = NULL,
                  completed_at = NULL, updated_at = now() WHERE id = $1`,
          [job.id],
        );
        result = { attempt: job.attempt, jobId: job.id };
      } else {
        if (job.attempt >= MEMORY_EXTRACTION_MAX_OPERATOR_ATTEMPTS) {
          throw new AppError(
            "AGENT_MEMORY_EXTRACTION_REQUEUE_LIMIT",
            "Достигнут предел явных попыток извлечения; проверьте диагностику пакета",
          );
        }
        const inserted = await client.query<{ attempt: number; id: string }>(
          `INSERT INTO memory_extraction_jobs (batch_id, attempt)
           VALUES ($1, $2) RETURNING id, attempt`,
          [batchId, job.attempt + 1],
        );
        result = { attempt: inserted.rows[0]!.attempt, jobId: inserted.rows[0]!.id };
      }
      await client.query(
        "UPDATE memory_extraction_batches SET status = 'pending', updated_at = now() WHERE id = $1",
        [batchId],
      );
      await client.query(
        "UPDATE memory_extraction_ranges SET status = 'pending', updated_at = now() WHERE batch_id = $1",
        [batchId],
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async rejectPendingCandidates(batchId: string, diagnosticCode: string): Promise<number> {
    const code = requireExtractionDiagnostic(diagnosticCode);
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const batch = await client.query<{ status: ExtractionStatus }>(
        `SELECT status FROM memory_extraction_batches
         WHERE id = $1 AND status IN ('completed', 'completed_empty') FOR UPDATE`,
        [batchId],
      );
      if (!batch.rows[0]) {
        throw new AppError(
          "AGENT_MEMORY_EXTRACTION_CANDIDATE_REJECTION_INVALID",
          "Отклонить candidates можно только после завершённого extraction batch",
        );
      }
      const rejected = await client.query(
        `UPDATE memory_extraction_candidates
         SET resolution_status = 'rejected', resolution_diagnostic_code = $2,
             resolved_at = now()
         WHERE batch_id = $1 AND resolution_status = 'pending'`,
        [batchId, code],
      );
      await client.query("COMMIT");
      return rejected.rowCount ?? 0;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async eraseTerminalSnapshot(batchId: string): Promise<boolean> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const erased = await client.query(
        `UPDATE memory_extraction_batches
         SET snapshot_erased_at = coalesce(snapshot_erased_at, now()), updated_at = now()
         WHERE id = $1 AND status IN ('completed', 'completed_empty', 'failed')
           AND NOT EXISTS (
             SELECT 1 FROM memory_extraction_jobs
             WHERE batch_id = $1 AND status IN ('pending', 'leased')
           )
            AND NOT EXISTS (
               SELECT 1 FROM memory_extraction_candidates
               WHERE batch_id = $1 AND resolution_status IN (
                 'pending', 'resolution_processing', 'approval_pending',
                 'consolidation_pending', 'resolution_failed'
               )
            )`,
        [batchId],
      );
      if (!erased.rowCount) {
        throw new AppError(
          "AGENT_MEMORY_EXTRACTION_ERASURE_UNSAFE",
          "Снимок можно удалить только после terminal state без активной задачи",
        );
      }
      await client.query(
        `UPDATE memory_extraction_snapshot_entries
         SET content_text = NULL, erased_at = coalesce(erased_at, now()) WHERE batch_id = $1`,
        [batchId],
      );
      await client.query(
        `UPDATE memory_extraction_candidates
         SET content = NULL, plaintext_erased_at = coalesce(plaintext_erased_at, now())
         WHERE batch_id = $1`,
        [batchId],
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

  async cleanupNextResolvedSnapshot(): Promise<boolean> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{ id: string }>(
        `SELECT batch.id FROM memory_extraction_batches AS batch
         WHERE batch.status IN ('completed', 'completed_empty')
           AND batch.snapshot_erased_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM memory_extraction_candidates AS candidate
             WHERE candidate.batch_id = batch.id AND candidate.resolution_status IN (
               'pending', 'resolution_processing', 'approval_pending',
               'consolidation_pending', 'resolution_failed'
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM memory_consolidation_jobs AS consolidation
             WHERE consolidation.candidate_row_id IN (
               SELECT id FROM memory_extraction_candidates WHERE batch_id = batch.id
             ) AND consolidation.status IN ('pending', 'leased')
           )
         ORDER BY batch.updated_at, batch.created_at, batch.id
         FOR UPDATE OF batch SKIP LOCKED LIMIT 1`,
      );
      const batchId = selected.rows[0]?.id;
      if (!batchId) {
        await client.query("COMMIT");
        return false;
      }
      await client.query(
        `UPDATE memory_extraction_snapshot_entries
         SET content_text = NULL, erased_at = coalesce(erased_at, now()) WHERE batch_id = $1`,
        [batchId],
      );
      await client.query(
        `UPDATE memory_extraction_candidates
         SET content = NULL, plaintext_erased_at = coalesce(plaintext_erased_at, now())
         WHERE batch_id = $1`,
        [batchId],
      );
      await client.query(
        `UPDATE memory_extraction_batches
         SET snapshot_erased_at = coalesce(snapshot_erased_at, now()), updated_at = now()
         WHERE id = $1`,
        [batchId],
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

  async getRange(batchId: string): Promise<MemoryExtractionRange> {
    const result = await database().query<{
      first_sequence: string;
      last_sequence: string;
      message_thread_id: string | null;
      omitted_before_sequence: string | null;
      status: ExtractionStatus;
    }>(
      `SELECT first_sequence::text, last_sequence::text, omitted_before_sequence::text,
              message_thread_id::text, status
       FROM memory_extraction_ranges WHERE batch_id = $1`,
      [batchId],
    );
    const range = result.rows[0];
    if (!range) {
      throw new AppError("AGENT_MEMORY_EXTRACTION_RANGE_NOT_FOUND", "Диапазон извлечения не найден");
    }
    return {
      firstSequence: range.first_sequence,
      lastSequence: range.last_sequence,
      messageThreadId: range.message_thread_id,
      omittedBeforeSequence: range.omitted_before_sequence,
      status: range.status,
    };
  },
};
