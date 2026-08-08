/**
 * Verified database records used by memory consolidation jobs.
 *
 * Exports:
 * - `CandidateIdentityRow`: extraction candidate identity projected from durable source rows.
 * - `ExistingCandidateRow`: active claim fields exposed to consolidation guards.
 * - `loadCandidateIdentity`: loads one unresolved candidate with its verified primary author.
 * - `payloadHash`: produces deterministic audit hashes for job input and output payloads.
 * - `subjectRef`: canonicalizes a persisted subject identity for guard comparison.
 */
import { createHash } from "node:crypto";

import { AppError } from "./app-error.js";
import { database } from "./database.js";
import type { ConsolidationGuardClaim } from "./memory-consolidation-guards.js";

export interface CandidateIdentityRow {
  author_ref: string;
  candidate_id: string;
  content: string;
  evidence_kind: "firsthand" | "inferred" | "reported";
  family_id: string;
  kind: ConsolidationGuardClaim["kind"];
  operation_key: string;
  scope: "family" | "group" | "personal";
  scope_partition_key: string;
  subject_label: string | null;
  subject_participant_id: string | null;
  subject_user_id: string | null;
}

export interface ExistingCandidateRow {
  author_ref: string | null;
  candidate_ref: string;
  content: string;
  evidence_kind: "explicit" | "firsthand" | "inferred" | "reported";
  id: string;
  kind: ConsolidationGuardClaim["kind"];
}

export function payloadHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function subjectRef(row: {
  subject_label: string | null;
  subject_participant_id: string | null;
  subject_user_id: string | null;
}): string {
  if (row.subject_user_id) return `user:${row.subject_user_id}`;
  if (row.subject_participant_id) return `participant:${row.subject_participant_id}`;
  if (row.subject_label) return `label:${row.subject_label.normalize("NFKC").toLocaleLowerCase("ru-RU")}`;
  return "subjectless";
}

export async function loadCandidateIdentity(candidateRowId: string): Promise<CandidateIdentityRow> {
  const result = await database().query<CandidateIdentityRow>(
    `SELECT candidate.candidate_id, candidate.operation_key, candidate.content,
            candidate.kind::text, candidate.evidence_kind, batch.family_id, batch.scope,
            batch.scope_partition_key,
            CASE WHEN batch.scope = 'group' THEN subject.id ELSE NULL END AS subject_participant_id,
            CASE WHEN batch.scope <> 'group' THEN subject.linked_user_id ELSE NULL END AS subject_user_id,
            candidate.subject_label,
            CASE WHEN primary_author.linked_user_id IS NOT NULL
                 THEN 'user:' || primary_author.linked_user_id::text
                 ELSE 'telegram:' || primary_author.telegram_user_id END AS author_ref
     FROM memory_extraction_candidates AS candidate
     JOIN memory_extraction_batches AS batch ON batch.id = candidate.batch_id
     JOIN memory_extraction_candidate_sources AS source
       ON source.candidate_row_id = candidate.id AND source.source_role = 'primary'
     JOIN memory_extraction_snapshot_entries AS snapshot ON snapshot.id = source.snapshot_entry_id
     JOIN conversation_participants AS primary_author ON primary_author.id = snapshot.author_participant_id
     LEFT JOIN conversation_participants AS subject
       ON subject.conversation_id = batch.conversation_id
      AND subject.participant_ref = candidate.subject_participant_ref
     WHERE candidate.id = $1 AND candidate.resolution_status = 'resolution_processing'`,
    [candidateRowId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError(
      "AGENT_MEMORY_CONSOLIDATION_CANDIDATE_INVALID",
      "Кандидат consolidation уже обработан или потерял verified identity",
    );
  }
  return row;
}
