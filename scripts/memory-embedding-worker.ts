/**
 * Durable local memory embedding worker entrypoint.
 *
 * Constructs:
 * - Claims bounded PostgreSQL batches and calls the pinned local TEI service.
 * - Completes each lease atomically or records one terminal failure without hidden retries.
 * - Fills thread title vectors left by a model change before records (40 titles take seconds, the
 *   record backlog minutes); a title that fails is skipped until the worker restarts.
 * - Stops gracefully on SIGINT/SIGTERM and releases the database pool.
 */
import { isAppError } from "../agent/lib/app-error.js";
import { closeDatabase } from "../agent/lib/database.js";
import { chunkMemoryContent, type MemoryEmbeddingChunkText } from "../agent/lib/memory-embedding-chunks.js";
import { embedMemoryPassages } from "../agent/lib/memory-embedding-client.js";
import {
  MEMORY_EMBEDDING_CHUNK_NARROW_MAX_CHARACTERS,
  MEMORY_EMBEDDING_JOB_BATCH_SIZE,
  MEMORY_EMBEDDING_LEASE_MILLISECONDS,
  MEMORY_EMBEDDING_MODEL_VERSION,
  MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE,
} from "../agent/lib/memory-config.js";
import { memoryIndexRepository } from "../agent/lib/memory-index-repository.js";
import { memoryThreadTitleIndexRepository } from "../agent/lib/memory-thread-title-index.js";

const IDLE_POLL_MILLISECONDS = 1_000;
let stopping = false;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorCode(error: unknown): string {
  return isAppError(error) ? error.code : "AGENT_MEMORY_EMBEDDING_UNEXPECTED";
}

async function embedChunks(chunks: readonly MemoryEmbeddingChunkText[]): Promise<number[][]> {
  const embeddings: number[][] = [];
  for (let offset = 0; offset < chunks.length; offset += MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE) {
    embeddings.push(...await embedMemoryPassages(
      chunks.slice(offset, offset + MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE).map((chunk) => chunk.content),
    ));
  }
  return embeddings;
}

/**
 * Chunks and embeds one record. The cap is in characters while the embedder counts tokens: a
 * record the embedder refuses (text that is punctuation or emoji throughout) is re-chunked
 * with the narrow cap, which fits any text, before it can fail.
 */
export async function embedRecord(
  content: string,
): Promise<{ chunks: MemoryEmbeddingChunkText[]; embeddings: number[][] }> {
  const chunks = chunkMemoryContent(content);
  try {
    return { chunks, embeddings: await embedChunks(chunks) };
  } catch (error) {
    if (!isAppError(error) || error.code !== "AGENT_MEMORY_EMBEDDING_INPUT_TOO_LONG") throw error;
    const narrow = chunkMemoryContent(content, { maxCharacters: MEMORY_EMBEDDING_CHUNK_NARROW_MAX_CHARACTERS });
    return { chunks: narrow, embeddings: await embedChunks(narrow) };
  }
}

async function processBatch(): Promise<number> {
  const jobs = await memoryIndexRepository.claim(
    MEMORY_EMBEDDING_JOB_BATCH_SIZE,
    MEMORY_EMBEDDING_LEASE_MILLISECONDS,
  );
  if (jobs.length === 0) return 0;

  // Each parent is all-or-nothing: provider batches are bounded, then every chunk commits together.
  for (const job of jobs) {
    try {
      const { chunks, embeddings } = await embedRecord(job.content);
      const completed = await memoryIndexRepository.complete(
        job.memoryItemId,
        job.leaseToken,
        chunks.map((chunk, index) => ({ ...chunk, embedding: embeddings[index]! })),
        MEMORY_EMBEDDING_MODEL_VERSION,
      );
      if (completed) continue;
      console.error(JSON.stringify({
        code: "AGENT_MEMORY_EMBEDDING_LEASE_STALE",
        memoryItemId: job.memoryItemId,
        message: "Memory embedding completion was rejected",
      }));
    } catch (error) {
      const code = errorCode(error);
      console.error(JSON.stringify({
        code,
        errorName: error instanceof Error ? error.name : "UnknownError",
        memoryItemId: job.memoryItemId,
        message: "Memory embedding job failed terminally",
      }));
      try {
        await memoryIndexRepository.fail(job.memoryItemId, job.leaseToken, code);
      } catch (failureError) {
        if (!isAppError(failureError) || failureError.code !== "AGENT_MEMORY_EMBEDDING_LEASE_STALE") {
          throw failureError;
        }
      }
    }
  }
  return jobs.length;
}

const failedThreadTitles = new Set<string>();

async function processThreadTitles(): Promise<number> {
  const stale = await memoryThreadTitleIndexRepository.listStale(
    MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE,
    [...failedThreadTitles],
  );
  if (stale.length === 0) return 0;
  try {
    const embeddings = await embedMemoryPassages(stale.map((thread) => thread.title));
    for (const [index, thread] of stale.entries()) {
      await memoryThreadTitleIndexRepository.save(thread.id, thread.title, embeddings[index]!);
    }
  } catch (error) {
    for (const thread of stale) failedThreadTitles.add(thread.id);
    console.error(JSON.stringify({
      code: errorCode(error),
      errorName: error instanceof Error ? error.name : "UnknownError",
      message: "Thread title embedding failed; skipped until restart",
      threadIds: stale.map((thread) => thread.id),
    }));
  }
  return stale.length;
}

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

try {
  while (!stopping) {
    const processed = await processThreadTitles() || await processBatch();
    if (processed === 0) await sleep(IDLE_POLL_MILLISECONDS);
  }
} catch (error) {
  console.error(JSON.stringify({
    code: "AGENT_MEMORY_EMBEDDING_WORKER_FAILED",
    errorName: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  }));
  throw error;
} finally {
  await closeDatabase();
}
