/**
 * Explicit model-safe long-term memory contract.
 *
 * Exports:
 * - `MEMORY_REF_PATTERN`: validates opaque refs accepted at model-facing boundaries.
 * - `ModelMemory`: allowlisted DTO used by tools and automatic prompt retrieval.
 * - `ModelMemoryEvidence`: safe provenance attached to repository retrieval results.
 * - `toModelMemory`: removes database, identity, source, thread, and indexing metadata.
 */
import type { MemoryScope } from "./memory-context.js";
import type {
  MemoryConfirmation,
  MemoryKind,
  MemorySensitivity,
  ReferencedMemoryItem,
} from "./memory-record.js";

export const MEMORY_REF_PATTERN = /^mem_[0-9a-f]{32}$/u;

export interface ModelMemory {
  authorStatus: ReferencedMemoryItem["author"]["status"];
  confirmation: MemoryConfirmation;
  content: string;
  createdAt: string;
  kind: MemoryKind;
  memoryRef: string;
  scope: MemoryScope;
  sensitivity: MemorySensitivity;
  updatedAt: string;
  evidence?: ModelMemoryEvidence;
}

export interface ModelMemoryEvidence {
  authorLabel: string;
  kind: "firsthand" | "inferred" | "reported" | "unresolved";
  notice: string;
  observedAt: string;
}

export function memoryEvidenceNotice(kind: ModelMemoryEvidence["kind"]): string {
  if (kind === "reported") return "Сообщено другим участником; не является подтверждением субъекта.";
  if (kind === "inferred") return "Выведено моделью из источника; не является прямым заявлением субъекта.";
  if (kind === "firsthand") return "Прямое заявление проверенного автора источника.";
  return "Происхождение источника не установлено.";
}

export function toModelMemory(
  memory: ReferencedMemoryItem,
  evidence?: ModelMemoryEvidence,
): ModelMemory {
  // Build from an explicit allowlist so future internal fields cannot leak by object spreading.
  return {
    authorStatus: memory.author.status,
    confirmation: memory.confirmation,
    content: memory.content,
    createdAt: memory.createdAt,
    kind: memory.kind,
    memoryRef: memory.memoryRef,
    scope: memory.scope,
    sensitivity: memory.sensitivity,
    updatedAt: memory.updatedAt,
    ...(evidence === undefined ? {} : { evidence }),
  };
}
