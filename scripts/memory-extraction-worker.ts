/**
 * Background memory extraction worker process.
 *
 * Constructs:
 * - Bounded catch-up and one terminal provider attempt per durable batch.
 * - Idle polling with named code configuration, never provider retry.
 */
import { closeDatabase } from "../agent/lib/database.js";
import { processNextMemoryExtraction } from "../agent/lib/memory-extraction-worker.js";
import { MEMORY_EXTRACTION_WORKER_IDLE_MILLISECONDS } from "../agent/lib/memory-config.js";
import { runMemoryWorkerLoop } from "../agent/lib/memory-worker-loop.js";

const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());

await runMemoryWorkerLoop({
  close: closeDatabase,
  idleMilliseconds: MEMORY_EXTRACTION_WORKER_IDLE_MILLISECONDS,
  processNext: processNextMemoryExtraction,
  signal: shutdown.signal,
});
