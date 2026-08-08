/**
 * Durable terminal-attempt lifecycle for generated thread briefs.
 *
 * Exports:
 * - `MemoryThreadBriefJobClaim`: exclusive provider attempt or an existing terminal/busy state.
 * - `memoryThreadBriefJobRepository`: claim, provider marker, completion, and failure transitions.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { THREAD_BRIEF_JOB_LEASE_MILLISECONDS } from "./memory-config.js";

export type MemoryThreadBriefJobClaim =
  | { jobId: string; leaseToken: string; status: "leased" }
  | { status: "busy" }
  | { status: "completed" }
  | { status: "failed" };

export const memoryThreadBriefJobRepository = {
  async claim(input: {
    generation: number;
    modelVersion: string;
    schemaVersion: string;
    threadId: string;
  }): Promise<MemoryThreadBriefJobClaim> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO memory_thread_brief_jobs
           (thread_id, generation, model_version, schema_version)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (thread_id, generation, model_version, schema_version) DO NOTHING`,
        [input.threadId, input.generation, input.modelVersion, input.schemaVersion],
      );
      const current = await client.query<{
        id: string;
        lease_expires_at: Date | null;
        status: "completed" | "failed" | "leased" | "pending";
      }>(
        `SELECT id, status, lease_expires_at FROM memory_thread_brief_jobs
         WHERE thread_id = $1 AND generation = $2 AND model_version = $3 AND schema_version = $4
         FOR UPDATE`,
        [input.threadId, input.generation, input.modelVersion, input.schemaVersion],
      );
      const job = current.rows[0]!;
      if (job.status === "leased" && job.lease_expires_at! <= new Date()) {
        await client.query(
          `UPDATE memory_thread_brief_jobs
           SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
               diagnostic_code = 'AGENT_MEMORY_THREAD_BRIEF_LEASE_EXPIRED',
               completed_at = now(), updated_at = now() WHERE id = $1`,
          [job.id],
        );
        await client.query("COMMIT");
        return { status: "failed" };
      }
      if (job.status !== "pending") {
        await client.query("COMMIT");
        return { status: job.status === "leased" ? "busy" : job.status };
      }
      const leased = await client.query<{ id: string; lease_token: string }>(
        `UPDATE memory_thread_brief_jobs
         SET status = 'leased', lease_token = gen_random_uuid(),
             lease_expires_at = now() + ($2::text || ' milliseconds')::interval,
             updated_at = now()
         WHERE id = $1 RETURNING id, lease_token::text`,
        [job.id, THREAD_BRIEF_JOB_LEASE_MILLISECONDS],
      );
      await client.query("COMMIT");
      return {
        jobId: leased.rows[0]!.id,
        leaseToken: leased.rows[0]!.lease_token,
        status: "leased",
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async markProviderCallStarted(jobId: string, leaseToken: string): Promise<void> {
    const result = await database().query(
      `UPDATE memory_thread_brief_jobs
       SET provider_call_started_at = coalesce(provider_call_started_at, now()), updated_at = now()
       WHERE id = $1 AND status = 'leased' AND lease_token = $2 AND lease_expires_at > now()`,
      [jobId, leaseToken],
    );
    if (!result.rowCount) {
      throw new AppError(
        "AGENT_MEMORY_THREAD_BRIEF_JOB_STALE",
        "Задача построения брифа больше не арендована",
      );
    }
  },

  async complete(
    client: PoolClient,
    jobId: string,
    leaseToken: string,
    outputPayloadHash: string,
  ): Promise<void> {
    const result = await client.query(
      `UPDATE memory_thread_brief_jobs
       SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
           output_payload_hash = $3, completed_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'leased' AND lease_token = $2
         AND lease_expires_at > now() AND provider_call_started_at IS NOT NULL`,
      [jobId, leaseToken, outputPayloadHash],
    );
    if (!result.rowCount) {
      throw new AppError(
        "AGENT_MEMORY_THREAD_BRIEF_JOB_STALE",
        "Lease брифа истёк до сохранения результата",
      );
    }
  },

  async fail(jobId: string, leaseToken: string, diagnosticCode: string): Promise<void> {
    await database().query(
      `UPDATE memory_thread_brief_jobs
       SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
           diagnostic_code = $3, completed_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'leased' AND lease_token = $2`,
      [jobId, leaseToken, diagnosticCode],
    );
  },
};
