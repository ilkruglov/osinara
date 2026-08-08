/**
 * Durable memory extraction contracts and shared projections.
 *
 * Exports:
 * - Extraction batch, snapshot, lease, completion, range, create, and complete contracts.
 * - Validation/hash helpers and PostgreSQL result projections shared by repository modules.
 */
import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import type { MemorySemanticDecision } from "./memory-semantic-extractor.js";

export type ExtractionStatus = "completed" | "completed_empty" | "failed" | "leased" | "pending";

export interface MemoryExtractionSnapshotEntry {
  actorKind: "agent_self" | "user";
  actorLabel: string | null;
  authorParticipantId: string | null;
  contentText: string | null;
  id: string;
  messageThreadId: string | null;
  observedAt: string;
  participantRef: string | null;
  replyToSourceRef: string | null;
  sequenceId: string;
  sourceRef: string;
  telegramMessageId: string;
}

export interface MemoryExtractionBatch {
  id: string;
  inputPayloadHash: string;
  snapshotEntries: MemoryExtractionSnapshotEntry[];
  status: ExtractionStatus;
}

export interface LeasedMemoryExtractionJob {
  attempt: number;
  batchId: string;
  id: string;
  leaseToken: string;
}

export interface CompletedMemoryExtraction {
  candidates: Array<{ candidateId: string; operationKey: string }>;
  partialResults: boolean;
  status: "completed" | "completed_empty";
}

export interface MemoryExtractionRange {
  firstSequence: string;
  lastSequence: string;
  messageThreadId: string | null;
  omittedBeforeSequence: string | null;
  status: ExtractionStatus;
}

export interface CreateMemoryExtractionBatchInput {
  applicationSessionId: string | null;
  callerTelegramUserId: string | null;
  conversationId: string;
  extractorVersion: string;
  firstSequence: string;
  lastSequence: string;
  messageThreadId?: string | null;
  omittedBeforeSequence: string | null;
  schemaVersion: string;
  timelineEntryIds: readonly string[];
  turnId: string;
}

export interface CreateTurnMemoryExtractionBatchInput
  extends CreateMemoryExtractionBatchInput {
  applicationSessionId: string;
  eveSessionId: string;
}

export interface CompleteMemoryExtractionInput {
  decisions: readonly MemorySemanticDecision[];
  diagnosticCode: string | null;
  jobId: string;
  leaseToken: string;
  partialResults: boolean;
}

interface SnapshotRow {
  actor_kind: "agent_self" | "user";
  actor_label_snapshot: string | null;
  author_participant_id: string | null;
  content_text: string | null;
  erased_at: Date | null;
  id: string;
  message_thread_id: string | null;
  observed_at: Date;
  participant_ref: string | null;
  reply_to_source_ref: string | null;
  sequence_id: string;
  source_ref: string;
  telegram_message_id: string;
}

export function extractionPayloadHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function requireExtractionBigint(value: string, field: string, allowZero = false): bigint {
  const pattern = allowZero ? /^\d+$/u : /^[1-9]\d*$/u;
  if (!pattern.test(value)) {
    throw new AppError(
      "AGENT_MEMORY_EXTRACTION_RANGE_INVALID",
      `Диапазон извлечения содержит некорректное поле ${field}`,
    );
  }
  return BigInt(value);
}

export function requireExtractionDiagnostic(code: string): string {
  if (!/^AGENT_[A-Z0-9_]+$/u.test(code)) {
    throw new AppError(
      "AGENT_MEMORY_EXTRACTION_DIAGNOSTIC_INVALID",
      "Диагностика извлечения должна содержать стабильный код ошибки",
    );
  }
  return code;
}

export async function loadExtractionBatch(
  client: PoolClient,
  batchId: string,
): Promise<MemoryExtractionBatch> {
  const batch = await client.query<{
    id: string;
    input_payload_hash: string;
    status: ExtractionStatus;
  }>("SELECT id, input_payload_hash, status FROM memory_extraction_batches WHERE id = $1", [batchId]);
  const row = batch.rows[0];
  if (!row) {
    throw new AppError("AGENT_MEMORY_EXTRACTION_BATCH_NOT_FOUND", "Пакет извлечения не найден");
  }
  const snapshots = await client.query<SnapshotRow>(
    `SELECT snapshot.id, snapshot.sequence_id::text, snapshot.actor_kind,
            snapshot.actor_label_snapshot,
            snapshot.author_participant_id, participant.participant_ref, snapshot.observed_at,
            snapshot.content_text, snapshot.erased_at, snapshot.telegram_message_id::text,
            snapshot.message_thread_id::text, snapshot.source_ref,
            replied.source_ref AS reply_to_source_ref
     FROM memory_extraction_snapshot_entries AS snapshot
     LEFT JOIN conversation_participants AS participant ON participant.id = snapshot.author_participant_id
     LEFT JOIN memory_extraction_snapshot_entries AS replied
       ON replied.batch_id = snapshot.batch_id
      AND replied.sequence_id = snapshot.reply_to_sequence_id
     WHERE snapshot.batch_id = $1 ORDER BY snapshot.ordinal`,
    [batchId],
  );
  const snapshotEntries = snapshots.rows.map((snapshot): MemoryExtractionSnapshotEntry => {
    if (snapshot.erased_at !== null) {
      throw new AppError(
        "AGENT_MEMORY_EXTRACTION_SNAPSHOT_ERASED",
        "Исходный снимок извлечения уже удалён по политике хранения",
      );
    }
    return {
      actorKind: snapshot.actor_kind,
      actorLabel: snapshot.actor_label_snapshot,
      authorParticipantId: snapshot.author_participant_id,
      contentText: snapshot.content_text,
      id: snapshot.id,
      messageThreadId: snapshot.message_thread_id,
      observedAt: snapshot.observed_at.toISOString(),
      participantRef: snapshot.participant_ref,
      replyToSourceRef: snapshot.reply_to_source_ref,
      sequenceId: snapshot.sequence_id,
      sourceRef: snapshot.source_ref,
      telegramMessageId: snapshot.telegram_message_id,
    };
  });
  return { id: row.id, inputPayloadHash: row.input_payload_hash, snapshotEntries, status: row.status };
}

export async function loadExtractionCompletion(
  client: PoolClient,
  jobId: string,
): Promise<CompletedMemoryExtraction> {
  const jobs = await client.query<{
    partial_results: boolean;
    status: "completed" | "completed_empty";
  }>(
    `SELECT status, partial_results FROM memory_extraction_jobs
     WHERE id = $1 AND status IN ('completed', 'completed_empty')`,
    [jobId],
  );
  const job = jobs.rows[0];
  if (!job) {
    throw new AppError(
      "AGENT_MEMORY_EXTRACTION_JOB_STALE",
      "Результат относится к неактуальной задаче извлечения",
    );
  }
  const candidates = await client.query<{ candidate_id: string; operation_key: string }>(
    `SELECT candidate_id, operation_key FROM memory_extraction_candidates
     WHERE job_id = $1 ORDER BY candidate_id`,
    [jobId],
  );
  return {
    candidates: candidates.rows.map((candidate) => ({
      candidateId: candidate.candidate_id,
      operationKey: candidate.operation_key,
    })),
    partialResults: job.partial_results,
    status: job.status,
  };
}
