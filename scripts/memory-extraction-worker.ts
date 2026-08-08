/**
 * Background memory extraction worker process.
 *
 * Constructs:
 * - Bounded catch-up and one terminal provider attempt per durable batch.
 * - Readiness marker written only after the first successful complete worker pass.
 * - Idle polling with named code configuration, never provider retry.
 */
import { rm, writeFile } from "node:fs/promises";

import { closeDatabase } from "../agent/lib/database.js";
import { processNextMemoryExtraction } from "../agent/lib/memory-extraction-worker.js";
import {
  MEMORY_EXTRACTION_WORKER_IDLE_MILLISECONDS,
  MEMORY_EXTRACTION_WORKER_READY_PATH,
} from "../agent/lib/memory-config.js";
import { runMemoryWorkerLoop } from "../agent/lib/memory-worker-loop.js";

const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());

// A container restart reuses its writable layer, so stale readiness must be cleared before work.
await rm(MEMORY_EXTRACTION_WORKER_READY_PATH, { force: true });
await runMemoryWorkerLoop({
  close: closeDatabase,
  idleMilliseconds: MEMORY_EXTRACTION_WORKER_IDLE_MILLISECONDS,
  markReady: async () => await writeFile(
    MEMORY_EXTRACTION_WORKER_READY_PATH,
    "ready\n",
    { encoding: "utf8", mode: 0o600 },
  ),
  processNext: processNextMemoryExtraction,
  signal: shutdown.signal,
});
