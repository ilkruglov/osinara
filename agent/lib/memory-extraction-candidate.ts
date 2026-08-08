/**
 * Application-owned memory extraction candidate identity.
 *
 * Exports:
 * - `MemoryExtractionCandidateInput`: closed candidate payload without model-selected IDs or scope.
 * - `canonicalMemoryExtractionCandidate`: validates and deterministically normalizes candidate data.
 * - `memoryExtractionCandidateId`: stable SHA-256 identity computed by the application.
 * - `memoryExtractionOperationKey`: batch + candidate + schema claim writer operation key.
 */
import { createHash } from "node:crypto";

import { AppError } from "./app-error.js";
import {
  MEMORY_CONTENT_MAX_LENGTH,
  MEMORY_EXTRACTION_SUBJECT_LABEL_MAX_CHARACTERS,
  MEMORY_EXTRACTION_VERSION_MAX_CHARACTERS,
} from "./memory-config.js";
import type { MemoryKind, MemorySensitivity } from "./memory-record.js";

const MEMORY_KINDS: readonly MemoryKind[] = [
  "episode", "fact", "family_shared", "preference", "profile",
];
const MEMORY_SENSITIVITIES: readonly MemorySensitivity[] = ["normal", "sensitive"];
const EVIDENCE_KINDS: readonly MemoryEvidenceKind[] = ["firsthand", "inferred", "reported"];

export type MemoryEvidenceKind = "firsthand" | "inferred" | "reported";

export interface MemoryExtractionCandidateInput {
  content: string;
  evidenceKind: MemoryEvidenceKind;
  kind: MemoryKind;
  primarySnapshotEntryId: string;
  sensitivity: MemorySensitivity;
  subjectLabel?: string;
  subjectParticipantRef?: string;
  supportingSnapshotEntryIds: readonly string[];
}

export interface CanonicalMemoryExtractionCandidate {
  content: string;
  evidenceKind: MemoryEvidenceKind;
  kind: MemoryKind;
  primarySnapshotEntryId: string;
  sensitivity: MemorySensitivity;
  subjectLabel: string | null;
  subjectParticipantRef: string | null;
  supportingSnapshotEntryIds: string[];
}

function requireText(value: string, field: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!normalized) {
    throw new AppError(
      "AGENT_MEMORY_EXTRACTION_CANDIDATE_INVALID",
      `Кандидат памяти не содержит обязательное поле ${field}`,
    );
  }
  return normalized;
}

function requireSchemaVersion(value: string): string {
  const schema = requireText(value, "schemaVersion");
  if (schema.length > MEMORY_EXTRACTION_VERSION_MAX_CHARACTERS) {
    throw new AppError(
      "AGENT_MEMORY_EXTRACTION_CANDIDATE_INVALID",
      "Версия extraction schema превышает допустимый размер",
    );
  }
  return schema;
}

export function canonicalMemoryExtractionCandidate(
  candidate: MemoryExtractionCandidateInput,
): CanonicalMemoryExtractionCandidate {
  if (
    !MEMORY_KINDS.includes(candidate.kind) ||
    !MEMORY_SENSITIVITIES.includes(candidate.sensitivity) ||
    !EVIDENCE_KINDS.includes(candidate.evidenceKind)
  ) {
    throw new AppError(
      "AGENT_MEMORY_EXTRACTION_CANDIDATE_INVALID",
      "Кандидат памяти содержит неподдерживаемый тип, sensitivity или evidence kind",
    );
  }
  const primarySnapshotEntryId = requireText(
    candidate.primarySnapshotEntryId,
    "primarySnapshotEntryId",
  );
  const supportingSnapshotEntryIds = [...new Set(
    candidate.supportingSnapshotEntryIds.map((id) => requireText(id, "supportingSnapshotEntryIds")),
  )].sort();
  if (supportingSnapshotEntryIds.includes(primarySnapshotEntryId)) {
    throw new AppError(
      "AGENT_MEMORY_EXTRACTION_CANDIDATE_INVALID",
      "Основной источник кандидата не должен повторяться среди supporting-источников",
    );
  }

  // Subject refs and labels are mutually exclusive signals; repository resolution owns identity.
  const subjectLabel = candidate.subjectLabel === undefined
    ? null
    : requireText(candidate.subjectLabel, "subjectLabel");
  const subjectParticipantRef = candidate.subjectParticipantRef === undefined
    ? null
    : requireText(candidate.subjectParticipantRef, "subjectParticipantRef");
  if (subjectLabel !== null && subjectParticipantRef !== null) {
    throw new AppError(
      "AGENT_MEMORY_EXTRACTION_CANDIDATE_INVALID",
      "Кандидат памяти не может одновременно выбирать subjectRef и свободную subjectLabel",
    );
  }
  if (subjectLabel !== null && subjectLabel.length > MEMORY_EXTRACTION_SUBJECT_LABEL_MAX_CHARACTERS) {
    throw new AppError(
      "AGENT_MEMORY_EXTRACTION_CANDIDATE_INVALID",
      "Свободная подпись субъекта превышает допустимый размер",
    );
  }

  const content = requireText(candidate.content, "content");
  if (content.length > MEMORY_CONTENT_MAX_LENGTH) {
    throw new AppError(
      "AGENT_MEMORY_EXTRACTION_CANDIDATE_INVALID",
      "Текст кандидата памяти превышает допустимый размер",
    );
  }
  return {
    content,
    evidenceKind: candidate.evidenceKind,
    kind: candidate.kind,
    primarySnapshotEntryId,
    sensitivity: candidate.sensitivity,
    subjectLabel,
    subjectParticipantRef,
    supportingSnapshotEntryIds,
  };
}

export function memoryExtractionCandidateId(
  candidate: MemoryExtractionCandidateInput,
  schemaVersion: string,
): string {
  const schema = requireSchemaVersion(schemaVersion);
  const payload = JSON.stringify({
    candidate: canonicalMemoryExtractionCandidate(candidate),
    schemaVersion: schema,
  });
  return `cand_${createHash("sha256").update(payload).digest("hex")}`;
}

export function memoryExtractionOperationKey(
  batchId: string,
  candidateId: string,
  schemaVersion: string,
): string {
  const batch = requireText(batchId, "batchId");
  const candidate = requireText(candidateId, "candidateId");
  const schema = requireSchemaVersion(schemaVersion);
  return `extraction:${batch}:${candidate}:${schema}`;
}
