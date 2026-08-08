/**
 * Activated memory-thread brief cache and bounded context repository.
 *
 * Exports:
 * - `createMemoryThreadBriefRepository`: injectable repository for cache integration tests.
 * - `memoryThreadBriefRepository.activate`: selects authorized signals, generates cache misses, and budgets context.
 * - Source selection and cache persistence are delegated to `memory-thread-brief-cache.ts`.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_EMBEDDING_MODEL_VERSION,
  THREAD_BRIEF_SCHEMA_VERSION,
  THREAD_CONTEXT_EPISODES_PER_THREAD,
  THREAD_EPISODE_MAX_CHARACTERS,
  THREAD_TITLE_MIN_SEMANTIC_SIMILARITY,
  THREAD_CONTEXT_MAX_THREADS,
} from "./memory-config.js";
import type { MemoryAuthorization } from "./memory-context.js";
import type { MemoryThreadBriefBlock } from "./memory-thread-brief-generator.js";
import { generateMemoryThreadBrief } from "./memory-thread-brief-generator.js";
import {
  loadBriefSources,
  loadCachedBrief,
  memoryThreadBriefPayloadHash,
  persistBrief,
  type SourceRow,
  THREAD_BRIEF_MODEL_VERSION,
} from "./memory-thread-brief-cache.js";
import { assembleMemoryThreadContext, type ActivatedMemoryThread, type MemoryThreadContext } from "./memory-thread-context.js";
import { loadMemoryThreadSourceEvidence } from "./memory-thread-source-evidence.js";
import { memoryThreadBriefJobRepository } from "./memory-thread-brief-job-repository.js";

interface ActivatedThreadRow {
  generation: number;
  id: string;
  purpose: string;
  retrieval_hits: number;
  skill_hint: boolean;
  status: "active" | "completed";
  thread_ref: string;
  title: string;
  title_similarity: number | string | null;
}

function vectorLiteral(vector: readonly number[]): string {
  if (vector.length !== MEMORY_EMBEDDING_DIMENSIONS ||
    !vector.every((value) => Number.isFinite(value))) {
    throw new AppError(
      "AGENT_MEMORY_THREAD_QUERY_EMBEDDING_INVALID",
      "Не удалось выполнить смысловой поиск нитей памяти",
    );
  }
  return `[${vector.join(",")}]`;
}

function titleSimilarity(value: number | string | null): number | null {
  if (value === null) return null;
  const similarity = Number(value);
  if (!Number.isFinite(similarity)) {
    throw new AppError(
      "AGENT_MEMORY_THREAD_SCORE_INVALID",
      "Не удалось проверить релевантность нити памяти",
    );
  }
  return similarity;
}

async function getOrGenerateBrief(
  thread: ActivatedThreadRow,
  generateBrief: typeof generateMemoryThreadBrief,
): Promise<MemoryThreadBriefBlock[] | null> {
  const cachedClient = await database().connect();
  try {
    const cached = await loadCachedBrief(cachedClient, thread.id, thread.generation);
    if (cached) return cached;
  } finally {
    cachedClient.release();
  }
  const claim = await memoryThreadBriefJobRepository.claim({
    generation: thread.generation,
    modelVersion: THREAD_BRIEF_MODEL_VERSION,
    schemaVersion: THREAD_BRIEF_SCHEMA_VERSION,
    threadId: thread.id,
  });
  if (claim.status === "busy") return null;
  if (claim.status === "completed") {
    throw new AppError(
      "AGENT_MEMORY_THREAD_BRIEF_CACHE_MISSING",
      "Завершённый бриф потерял сохранённую проекцию",
    );
  }
  if (claim.status === "failed") {
    throw new AppError(
      "AGENT_MEMORY_THREAD_BRIEF_RETRY_REQUIRED",
      "Построение брифа завершилось неоднозначно и требует явного повторного запуска",
    );
  }
  try {
    // Immutable source rows are loaded and validated before paid provider work is marked started.
    const sources = await loadBriefSources(database(), thread.id);
    if (sources.length === 0) {
      throw new AppError(
        "AGENT_MEMORY_THREAD_BRIEF_SOURCE_MISSING",
        "У нити памяти не осталось доступных подтверждённых источников",
      );
    }
    await memoryThreadBriefJobRepository.markProviderCallStarted(claim.jobId, claim.leaseToken);
    const blocks = await generateBrief({
      entries: sources,
      purpose: thread.purpose,
      title: thread.title,
    });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await persistBrief(client, thread, blocks);
      await memoryThreadBriefJobRepository.complete(
        client,
        claim.jobId,
        claim.leaseToken,
        memoryThreadBriefPayloadHash(blocks),
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const sourceRecordByEntry = new Map(sources.map((source) => [source.ref, source.sourceRef]));
    return blocks.map((block) => ({
      ...block,
      sourceRecordRefs: block.sourceEntryRefs.map((entryRef) => sourceRecordByEntry.get(entryRef)!),
    }));
  } catch (error) {
    await memoryThreadBriefJobRepository.fail(
      claim.jobId,
      claim.leaseToken,
      error instanceof AppError ? error.code : "AGENT_MEMORY_THREAD_BRIEF_PROVIDER_FAILED",
    );
    throw error;
  }
}

async function loadEpisodes(threadId: string): Promise<ActivatedMemoryThread["episodes"]> {
  const result = await database().query<SourceRow>(
    `SELECT entry.entry_ref, entry.role::text, entry.occurred_at,
            COALESCE(claim.content, outcome.summary) AS content,
            COALESCE(memory_ref.memory_ref, outcome.outcome_ref) AS source_ref
     FROM memory_thread_entries AS entry
     LEFT JOIN memory_items AS claim ON claim.id = entry.source_claim_id
       AND claim.claim_status = 'active' AND claim.provenance_state = 'evidenced'
       AND EXISTS (SELECT 1 FROM claim_evidence WHERE claim_id = claim.id)
     LEFT JOIN memory_item_refs AS memory_ref ON memory_ref.memory_item_id = claim.id
     LEFT JOIN confirmed_outcomes AS outcome ON outcome.id = entry.source_outcome_id AND outcome.status = 'confirmed'
     WHERE entry.thread_id = $1 AND entry.role = 'episode'
       AND char_length(COALESCE(claim.content, outcome.summary)) <= $2
     ORDER BY entry.occurred_at DESC, entry.id DESC LIMIT $3`,
    [threadId, THREAD_EPISODE_MAX_CHARACTERS, THREAD_CONTEXT_EPISODES_PER_THREAD],
  );
  return result.rows.map((row) => ({
    content: row.content,
    sourceEntryRefs: [row.entry_ref],
    sourceRecordRefs: [row.source_ref],
  }));
}

async function loadCompletionEpisode(threadId: string) {
  const result = await database().query<{ entry_ref: string; outcome_ref: string; summary: string }>(
    `SELECT entry.entry_ref, outcome.outcome_ref, outcome.summary
     FROM memory_threads AS thread
     JOIN confirmed_outcomes AS outcome ON outcome.id = thread.completion_outcome_id
     JOIN memory_thread_entries AS entry ON entry.thread_id = thread.id
       AND entry.source_outcome_id = outcome.id
     WHERE thread.id = $1 AND thread.status = 'completed'`,
    [threadId],
  );
  const row = result.rows[0];
  return row ? {
    content: row.summary,
    sourceEntryRefs: [row.entry_ref],
    sourceRecordRefs: [row.outcome_ref],
  } : undefined;
}

export function createMemoryThreadBriefRepository(dependencies: {
  generateBrief: typeof generateMemoryThreadBrief;
}) {
  return {
    async activate(input: {
    auth: MemoryAuthorization;
    queryEmbedding: readonly number[];
    retrievedClaimIds: readonly string[];
    skillHints: readonly string[];
  }): Promise<MemoryThreadContext> {
    const hints = [...new Set(input.skillHints.map((hint) =>
      hint.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("ru-RU")
    ))];
    const result = await database().query<ActivatedThreadRow>(
      `WITH hits AS (
         SELECT entry.thread_id, count(*)::integer AS retrieval_hits
         FROM memory_thread_entries AS entry
         JOIN memory_items AS claim ON claim.id = entry.source_claim_id
           AND claim.claim_status = 'active' AND claim.provenance_state = 'evidenced'
           AND EXISTS (SELECT 1 FROM claim_evidence WHERE claim_id = claim.id)
         WHERE entry.source_claim_id = ANY($5::uuid[]) GROUP BY entry.thread_id
       )
       SELECT thread.id, thread.thread_ref, thread.title, thread.purpose, thread.status::text,
              thread.generation, COALESCE(hits.retrieval_hits, 0) AS retrieval_hits,
              thread.title_normalized = ANY($7::text[]) AS skill_hint,
              CASE WHEN thread.title_embedding_model = $8
                THEN 1 - (thread.title_embedding <=> $6::vector) ELSE NULL END AS title_similarity
       FROM memory_threads AS thread LEFT JOIN hits ON hits.thread_id = thread.id
       WHERE thread.family_id = $1 AND (
         (thread.scope = 'personal' AND 'personal' = ANY($2::memory_scope[])
           AND thread.scope_partition_key = $3) OR
         (thread.scope = 'family' AND 'family' = ANY($2::memory_scope[])) OR
         (thread.scope = 'group' AND 'group' = ANY($2::memory_scope[])
           AND thread.scope_partition_key = $4)
        ) AND (thread.status = 'completed' OR EXISTS (
          SELECT 1 FROM memory_thread_entries AS available_entry
          LEFT JOIN memory_items AS available_claim ON available_claim.id = available_entry.source_claim_id
            AND available_claim.claim_status = 'active'
            AND available_claim.provenance_state = 'evidenced'
            AND EXISTS (SELECT 1 FROM claim_evidence WHERE claim_id = available_claim.id)
          LEFT JOIN confirmed_outcomes AS available_outcome
            ON available_outcome.id = available_entry.source_outcome_id
            AND available_outcome.status = 'confirmed'
          WHERE available_entry.thread_id = thread.id
            AND (available_claim.id IS NOT NULL OR available_outcome.id IS NOT NULL)
        )) AND (COALESCE(hits.retrieval_hits, 0) > 0 OR thread.title_normalized = ANY($7::text[])
         OR (thread.title_embedding_model = $8
           AND 1 - (thread.title_embedding <=> $6::vector) >= $9))
       ORDER BY skill_hint DESC,
                (thread.title_embedding_model = $8 AND
                  1 - (thread.title_embedding <=> $6::vector) >= $9) DESC,
                retrieval_hits DESC, thread.updated_at DESC
        LIMIT $10`,
      [input.auth.familyId, input.auth.scopes, input.auth.userId, input.auth.groupId,
        input.retrievedClaimIds, vectorLiteral(input.queryEmbedding), hints,
         MEMORY_EMBEDDING_MODEL_VERSION, THREAD_TITLE_MIN_SEMANTIC_SIMILARITY,
         THREAD_CONTEXT_MAX_THREADS],
    );
    const activated: ActivatedMemoryThread[] = [];
    for (const thread of result.rows) {
      const similarity = titleSimilarity(thread.title_similarity);
      if (thread.status === "completed") {
        activated.push({
          blocks: [],
          completionEpisode: await loadCompletionEpisode(thread.id),
          episodes: [],
          purpose: thread.purpose,
          relevance: {
            retrievalHits: thread.retrieval_hits,
            skillHint: thread.skill_hint,
            titleMatch: similarity !== null && similarity >= THREAD_TITLE_MIN_SEMANTIC_SIMILARITY,
          },
          sourceEvidence: await loadMemoryThreadSourceEvidence(database(), thread.id),
          status: thread.status,
          threadRef: thread.thread_ref,
          title: thread.title,
        });
        continue;
      }
      const blocks = await getOrGenerateBrief(thread, dependencies.generateBrief);
      if (blocks === null) continue;
      activated.push({
        blocks,
        episodes: await loadEpisodes(thread.id),
        purpose: thread.purpose,
        relevance: {
          retrievalHits: thread.retrieval_hits,
          skillHint: thread.skill_hint,
          titleMatch: similarity !== null && similarity >= THREAD_TITLE_MIN_SEMANTIC_SIMILARITY,
        },
        sourceEvidence: await loadMemoryThreadSourceEvidence(database(), thread.id),
        status: thread.status,
        threadRef: thread.thread_ref,
        title: thread.title,
      });
    }
    return assembleMemoryThreadContext(activated);
    },
  };
}

export const memoryThreadBriefRepository = createMemoryThreadBriefRepository({
  generateBrief: generateMemoryThreadBrief,
});
