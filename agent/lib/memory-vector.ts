/**
 * pgvector text literal of a memory embedding.
 *
 * Export:
 * - `memoryVectorLiteral`: `[a,b,…]` for a vector of the configured dimension with finite values,
 *   or the caller's error.
 *
 * Key construct:
 * - Index, retrieval, thread and near-duplicate queries each built this literal; one of them skipped
 *   the dimension check and would have passed a malformed vector straight to PostgreSQL.
 */
import type { AppError } from "./app-error.js";
import { MEMORY_EMBEDDING_DIMENSIONS } from "./memory-config.js";

export function memoryVectorLiteral(vector: readonly number[], invalid: () => AppError): string {
  if (vector.length !== MEMORY_EMBEDDING_DIMENSIONS || !vector.every((value) => Number.isFinite(value))) {
    throw invalid();
  }
  return `[${vector.join(",")}]`;
}
