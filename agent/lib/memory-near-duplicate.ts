/**
 * Near-duplicate gate at memory write time.
 *
 * Exports:
 * - `embedNearDuplicateCandidate`: the candidate content chunked and embedded as stored records
 *   are; `null` for a replay of a stored operation and when the embedder is unavailable (the gate
 *   is advisory).
 * - `findNearDuplicateClaims`: active records of the same subject whose embedding is close to
 *   the candidate content; bounded to a few candidates.
 * - `NearDuplicateRefusal`: the stop thrown inside the write transaction; its message is the code
 *   alone, the candidates travel in a field.
 * - `nearDuplicateRefusalResult`: the ordinary tool answer the model gets instead: the candidates
 *   and the three ways to proceed (`reinforces`, `attribute`, `distinct`).
 *
 * The prod embedder keeps distinct facts about one subject above the threshold too, so the gate
 * never merges on its own: the model that is already writing decides.
 *
 * Passage against passage, the best pair of chunks (6 October 2026). Until then the content was
 * embedded as a query and every write with an `attribute` skipped the gate, while the silent review
 * always names one: of 376 semantic writes in three days none was checked, and one fact landed in
 * two slots under two names («семья» and «дети», «медиапотребление» and «соцсети»). A write that
 * opens a new slot is now checked against the subject's other slots; a write into an existing
 * slot has read it through `slotUpdate` and versions it there.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import { database } from "./database.js";
import {
  MEMORY_EMBEDDING_MODEL_VERSION,
  MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE,
  MEMORY_NEAR_DUPLICATE_CANDIDATES,
  MEMORY_NEAR_DUPLICATE_SIMILARITY,
  MEMORY_SEMANTIC_KINDS,
} from "./memory-config.js";
import type { MemoryAuthorization, MemoryScope } from "./memory-context.js";
import { embedMemoryPassages } from "./memory-embedding-client.js";
import { chunkMemoryContent } from "./memory-embedding-chunks.js";
import type { MemoryKind } from "./memory-record.js";
import { memoryVectorLiteral } from "./memory-vector.js";

const NEAR_DUPLICATE_EMBEDDING_BUDGET_MILLISECONDS = 3_000;

export interface NearDuplicateCandidate {
  attribute: string | null;
  content: string;
  memoryRef: string;
  similarity: number;
}

export interface FindNearDuplicateClaimsInput {
  embeddings: readonly (readonly number[])[];
  kind: MemoryKind;
  /** The slot identity includes the project thread (`lockSlotClaims`), so the gate does too. */
  memoryProjectId: string | null;
  scope: MemoryScope;
  scopePartitionKey: string;
  /**
   * A slotted write meets slotted records only: the refinement goes into the candidate's slot
   * through `slotUpdate`, and an unslotted record has no slot to take it (the silent review has no
   * edit either), so such a refusal would leave no way forward (Codex review).
   */
  slottedOnly: boolean;
  subjectLabel: string | null;
  subjectParticipantId: string | null;
  subjectUserId: string | null;
}

export function isSemanticMemoryKind(kind: MemoryKind): boolean {
  return (MEMORY_SEMANTIC_KINDS as readonly string[]).includes(kind);
}

export async function embedNearDuplicateCandidate(
  auth: MemoryAuthorization,
  operationKey: string,
  content: string,
): Promise<number[][] | null> {
  // A replay answers from the stored operation without the gate; it is not embedded for it.
  const operation = await database().query(
    "SELECT 1 FROM memory_mutation_operations WHERE family_id = $1 AND operation_key = $2",
    [auth.familyId, operationKey],
  );
  if ((operation.rowCount ?? 0) > 0) return null;
  try {
    const chunks = chunkMemoryContent(content).map((chunk) => chunk.content);
    // One budget for the whole record, as a turn's retrieval query has: the write waits on it.
    const signal = AbortSignal.timeout(NEAR_DUPLICATE_EMBEDDING_BUDGET_MILLISECONDS);
    const embeddings: number[][] = [];
    for (let offset = 0; offset < chunks.length; offset += MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE) {
      embeddings.push(...await embedMemoryPassages(
        chunks.slice(offset, offset + MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE),
        fetch,
        signal,
      ));
    }
    return embeddings;
  } catch (error) {
    // The gate is advisory: an unavailable embedder must not block a memory write.
    console.warn(JSON.stringify({
      code: "AGENT_MEMORY_NEAR_DUPLICATE_SKIPPED",
      error: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}

export async function findNearDuplicateClaims(
  client: PoolClient,
  auth: MemoryAuthorization,
  input: FindNearDuplicateClaimsInput,
): Promise<NearDuplicateCandidate[]> {
  if (!isSemanticMemoryKind(input.kind)) return [];
  const result = await client.query<{
    attribute: string | null;
    content: string;
    memory_ref: string;
    similarity: number | string;
  }>(
    `SELECT ref.memory_ref, item.content, item.attribute,
            MAX(1 - (chunk.embedding <=> candidate.embedding)) AS similarity
       FROM memory_items AS item
       JOIN memory_item_refs AS ref ON ref.memory_item_id = item.id
       JOIN memory_embedding_chunks AS chunk
         ON chunk.memory_item_id = item.id AND chunk.embedding_model = $6
      CROSS JOIN unnest($5::vector[]) AS candidate(embedding)
      WHERE item.family_id = $1 AND item.scope = $2 AND item.scope_partition_key = $3
        AND item.claim_status = 'active' AND item.deleted_at IS NULL
        AND item.embedding_status = 'indexed'
        AND item.kind = ANY($4::memory_kind[])
        AND item.subject_participant_id IS NOT DISTINCT FROM $7::uuid
        AND item.subject_user_id IS NOT DISTINCT FROM $8::uuid
        AND item.subject_label IS NOT DISTINCT FROM $9::text
        AND item.memory_project_id IS NOT DISTINCT FROM $12::uuid
        AND (NOT $13::boolean OR item.attribute IS NOT NULL)
      GROUP BY ref.memory_ref, item.content, item.attribute, item.created_at, item.id
     HAVING MAX(1 - (chunk.embedding <=> candidate.embedding)) >= $10
      ORDER BY similarity DESC, item.created_at DESC, item.id DESC
      LIMIT $11`,
    [auth.familyId, input.scope, input.scopePartitionKey, [...MEMORY_SEMANTIC_KINDS],
      input.embeddings.map((embedding) => memoryVectorLiteral(embedding, () => new AppError(
        "AGENT_MEMORY_EMBEDDING_VECTOR_INVALID",
        "Не удалось проверить похожие записи памяти",
      ))), MEMORY_EMBEDDING_MODEL_VERSION,
      input.subjectParticipantId, input.subjectUserId, input.subjectLabel,
      MEMORY_NEAR_DUPLICATE_SIMILARITY, MEMORY_NEAR_DUPLICATE_CANDIDATES,
      input.memoryProjectId, input.slottedOnly],
  );
  return result.rows.map((row) => ({
    attribute: row.attribute,
    content: row.content,
    memoryRef: row.memory_ref,
    similarity: Number(row.similarity),
  }));
}

/**
 * Not a failure: the write stops so the model looks at what is already stored. Thrown to abort the
 * transaction, but the candidates are memory content, and Eve logs every thrown tool error whole;
 * so the message carries the code alone and `remember` turns the stop into an answer (upstream
 * nyxandro/osinara v0.27.1, 20 September 2026, found the same leak into their log store).
 */
export class NearDuplicateRefusal extends Error {
  readonly code = "AGENT_MEMORY_NEAR_DUPLICATE";
  readonly candidates: readonly NearDuplicateCandidate[];

  constructor(candidates: readonly NearDuplicateCandidate[]) {
    super("AGENT_MEMORY_NEAR_DUPLICATE");
    this.name = "NearDuplicateRefusal";
    this.candidates = candidates;
  }
}

export function nearDuplicateRefusalResult(refusal: NearDuplicateRefusal) {
  return {
    code: refusal.code,
    instruction:
      "Похожие записи уже есть, новая не сохранена. Если это то же самое, повтори remember с reinforces=memoryRef; " +
      "если это новая версия или уточнение одной из них, повтори в её слот: attribute этой записи и slotUpdate " +
      "(add с её memoryRef или replace после чтения всего слота); у записи без слота исправь её через manage_memory " +
      "edit; если это другой факт, повтори с distinct=true.",
    saved: false as const,
    similar: refusal.candidates.map(({ attribute, content, memoryRef }) => ({ attribute, content, memoryRef })),
  };
}
