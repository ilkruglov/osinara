/**
 * Atomic memory extraction completion and candidate persistence.
 *
 * Exports:
 * - `memoryExtractionCompletionRepository`: validates sources and stores all-or-nothing output.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import {
  canonicalMemoryExtractionCandidate,
  memoryExtractionCandidateId,
  memoryExtractionOperationKey,
} from "./memory-extraction-candidate.js";
import {
  extractionPayloadHash,
  loadExtractionCompletion,
  requireExtractionDiagnostic,
  type CompleteMemoryExtractionInput,
  type CompletedMemoryExtraction,
  type ExtractionStatus,
} from "./memory-extraction-contract.js";
import { MEMORY_EXTRACTION_OUTPUT_MAX_CANDIDATES } from "./memory-config.js";

export const memoryExtractionCompletionRepository = {
  async complete(input: CompleteMemoryExtractionInput): Promise<CompletedMemoryExtraction> {
    if (
      input.decisions.length > MEMORY_EXTRACTION_OUTPUT_MAX_CANDIDATES ||
      (input.partialResults && input.decisions.length === 0) ||
      (input.partialResults && input.diagnosticCode === null) ||
      (!input.partialResults && input.diagnosticCode !== null)
    ) {
      throw new AppError(
        "AGENT_MEMORY_EXTRACTION_OUTPUT_INVALID",
        "Результат извлечения превышает лимит или содержит несогласованную диагностику",
      );
    }
    if (input.diagnosticCode !== null) requireExtractionDiagnostic(input.diagnosticCode);

    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const jobs = await client.query<{
        batch_id: string;
        diagnostic_code: string | null;
        output_payload_hash: string | null;
        partial_results: boolean;
        provider_call_started_at: Date | null;
        schema_version: string;
        status: ExtractionStatus;
      }>(
        `SELECT job.batch_id, job.status, job.output_payload_hash, job.partial_results,
                job.diagnostic_code, job.provider_call_started_at, batch.schema_version
         FROM memory_extraction_jobs AS job
         JOIN memory_extraction_batches AS batch ON batch.id = job.batch_id
         WHERE job.id = $1 FOR UPDATE`,
        [input.jobId],
      );
      const job = jobs.rows[0];
      if (!job) {
        throw new AppError("AGENT_MEMORY_EXTRACTION_JOB_STALE", "Задача извлечения не найдена");
      }

      // Candidate identity is recomputed over canonical application data; no model-provided ID,
      // scope, author, family, or group field enters persistence.
      const candidates = input.decisions.flatMap((decision, ordinal) => {
        if (decision.action === "skip" || decision.action === "ambiguous") return [];
        const candidate = {
          content: decision.content,
          evidenceKind: decision.evidenceKind,
          kind: decision.kind,
          primarySnapshotEntryId: decision.primarySnapshotEntryId,
          sensitivity: decision.sensitivity,
          ...(decision.subjectLabel === undefined ? {} : { subjectLabel: decision.subjectLabel }),
          ...(decision.subjectParticipantRef === undefined
            ? {}
            : { subjectParticipantRef: decision.subjectParticipantRef }),
          supportingSnapshotEntryIds: decision.supportingSnapshotEntryIds,
        };
        return [{
          action: decision.action,
          canonical: canonicalMemoryExtractionCandidate(candidate),
          candidateId: memoryExtractionCandidateId(candidate, job.schema_version),
          ongoingFutureWork: decision.ongoingFutureWork === true,
          ordinal,
        }];
      });
      if (new Set(candidates.map((candidate) => candidate.candidateId)).size !== candidates.length) {
        throw new AppError(
          "AGENT_MEMORY_EXTRACTION_CANDIDATE_DUPLICATE",
          "Результат извлечения содержит повтор одного атомарного кандидата",
        );
      }
      const outputHash = extractionPayloadHash(input.decisions);

      // A terminal replay is read-only and succeeds only for byte-equivalent canonical output and
      // the same explicit partial-result diagnostic.
      if (job.status === "completed" || job.status === "completed_empty") {
        if (
          job.output_payload_hash !== outputHash ||
          job.partial_results !== input.partialResults ||
          job.diagnostic_code !== input.diagnosticCode
        ) {
          throw new AppError(
            "AGENT_MEMORY_EXTRACTION_REPLAY_MISMATCH",
            "Повтор результата извлечения не совпадает с уже сохранённым",
          );
        }
        await client.query("COMMIT");
        return await loadExtractionCompletion(client, input.jobId);
      }
      if (job.status !== "leased" || job.provider_call_started_at === null) {
        throw new AppError(
          "AGENT_MEMORY_EXTRACTION_PROVIDER_MARKER_MISSING",
          "Нельзя завершить извлечение без актуального lease и durable provider-call marker",
        );
      }
      const leased = await client.query(
        `SELECT 1 FROM memory_extraction_jobs
         WHERE id = $1 AND lease_token = $2 AND lease_expires_at > now()`,
        [input.jobId, input.leaseToken],
      );
      if (!leased.rowCount) {
        throw new AppError("AGENT_MEMORY_EXTRACTION_JOB_STALE", "Lease задачи извлечения устарел");
      }

      const snapshots = await client.query<{
        actor_kind: "agent_self" | "user";
        author_participant_id: string | null;
        content_text: string | null;
        id: string;
      }>(
        `SELECT id, actor_kind, author_participant_id, content_text
         FROM memory_extraction_snapshot_entries
         WHERE batch_id = $1 AND erased_at IS NULL`,
        [job.batch_id],
      );
      const sourceById = new Map(snapshots.rows.map((source) => [source.id, source]));

      // Skip and ambiguous are durable closed decisions but still must reference this exact human
      // snapshot; otherwise a malformed provider response could forge coverage diagnostics.
      for (const decision of input.decisions) {
        if (decision.action !== "skip" && decision.action !== "ambiguous") continue;
        const source = sourceById.get(decision.primarySnapshotEntryId);
        if (
          !source || source.actor_kind !== "user" ||
          source.author_participant_id === null || !source.content_text?.trim()
        ) {
          throw new AppError(
            "AGENT_MEMORY_EXTRACTION_SOURCE_INVALID",
            "Решение извлечения ссылается на недоступный пользовательский источник",
          );
        }
      }

      // Every persisted source must be a verified human participant from this exact batch. Primary
      // uniqueness and same-batch ownership are also enforced by PostgreSQL.
      for (const candidate of candidates) {
        const sourceIds = [
          candidate.canonical.primarySnapshotEntryId,
          ...candidate.canonical.supportingSnapshotEntryIds,
        ];
        const sources = sourceIds.map((sourceId) => sourceById.get(sourceId));
        if (sources.some((source) =>
          source === undefined || source.actor_kind !== "user" ||
          source.author_participant_id === null || !source.content_text?.trim()
        )) {
          throw new AppError(
            "AGENT_MEMORY_EXTRACTION_SOURCE_INVALID",
            "Кандидат ссылается на недоступный или неподтверждённый пользовательский источник",
          );
        }
        if (candidate.canonical.subjectParticipantRef !== null) {
          const subject = await client.query(
            `SELECT 1 FROM conversation_participants AS participant
             JOIN memory_extraction_batches AS batch ON batch.conversation_id = participant.conversation_id
             WHERE batch.id = $1 AND participant.participant_ref = $2`,
            [job.batch_id, candidate.canonical.subjectParticipantRef],
          );
          if (!subject.rowCount) {
            throw new AppError(
              "AGENT_MEMORY_EXTRACTION_SUBJECT_INVALID",
              "Указанный субъект не принадлежит исходному разговору",
            );
          }
        }

        const operationKey = memoryExtractionOperationKey(
          job.batch_id,
          candidate.candidateId,
          job.schema_version,
        );
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO memory_extraction_candidates
              (job_id, batch_id, candidate_id, schema_version, operation_key, payload_hash,
               content, kind, sensitivity, evidence_kind, subject_participant_ref, subject_label,
               proposed_thread_continuation)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
          [input.jobId, job.batch_id, candidate.candidateId, job.schema_version, operationKey,
            extractionPayloadHash(candidate.canonical), candidate.canonical.content,
            candidate.canonical.kind, candidate.canonical.sensitivity,
            candidate.canonical.evidenceKind, candidate.canonical.subjectParticipantRef,
             candidate.canonical.subjectLabel, candidate.ongoingFutureWork],
        );
        const candidateRowId = inserted.rows[0]!.id;
        await client.query(
          `INSERT INTO memory_extraction_semantic_results
             (job_id, batch_id, ordinal, action, primary_snapshot_entry_id, candidate_row_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [input.jobId, job.batch_id, candidate.ordinal, candidate.action,
            candidate.canonical.primarySnapshotEntryId, candidateRowId],
        );
        await client.query(
          `INSERT INTO memory_extraction_candidate_sources
             (candidate_row_id, batch_id, snapshot_entry_id, source_role, source_order)
           VALUES ($1, $2, $3, 'primary', 0)`,
          [candidateRowId, job.batch_id, candidate.canonical.primarySnapshotEntryId],
        );
        for (const [index, sourceId] of candidate.canonical.supportingSnapshotEntryIds.entries()) {
          await client.query(
            `INSERT INTO memory_extraction_candidate_sources
               (candidate_row_id, batch_id, snapshot_entry_id, source_role, source_order)
             VALUES ($1, $2, $3, 'supporting', $4)`,
            [candidateRowId, job.batch_id, sourceId, index],
          );
        }
      }
      for (const [ordinal, decision] of input.decisions.entries()) {
        if (decision.action !== "skip" && decision.action !== "ambiguous") continue;
        await client.query(
          `INSERT INTO memory_extraction_semantic_results
             (job_id, batch_id, ordinal, action, primary_snapshot_entry_id, reason)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [input.jobId, job.batch_id, ordinal, decision.action,
            decision.primarySnapshotEntryId, decision.reason],
        );
      }

      // Candidates and terminal state commit together. Any validation or insert failure leaves the
      // leased job untouched, making partial persistence impossible.
      const status = candidates.length === 0 ? "completed_empty" : "completed";
      await client.query(
        `UPDATE memory_extraction_jobs SET status = $3, lease_token = NULL, lease_expires_at = NULL,
                diagnostic_code = $4, partial_results = $5, candidate_count = $6,
                output_payload_hash = $7, completed_at = now(), updated_at = now()
         WHERE id = $1 AND lease_token = $2`,
        [input.jobId, input.leaseToken, status, input.diagnosticCode, input.partialResults,
          candidates.length, outputHash],
      );
      await client.query(
        "UPDATE memory_extraction_batches SET status = $2, updated_at = now() WHERE id = $1",
        [job.batch_id, status],
      );
      await client.query(
        "UPDATE memory_extraction_ranges SET status = $2, updated_at = now() WHERE batch_id = $1",
        [job.batch_id, status],
      );
      await client.query("COMMIT");
      return await loadExtractionCompletion(client, input.jobId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
