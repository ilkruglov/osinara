/**
 * One-shot direct LLM extraction worker orchestration.
 *
 * Exports:
 * - `createMemoryExtractionWorker`: injectable terminal-attempt orchestration.
 * - `processNextMemoryExtraction`: extraction, consolidation, and thread discovery in one worker loop.
 */
import { AppError } from "./app-error.js";
import { createCatchUpExtractionBatches } from "./memory-extraction-batch-coordinator.js";
import { processNextMemoryConsolidation } from "./memory-consolidation-worker.js";
import {
  processMemoryExtractionCandidates,
  processNextPendingMemoryExtractionCandidates,
} from "./memory-extraction-candidate-processor.js";
import { memoryExtractionRepository } from "./memory-extraction-repository.js";
import { extractMemorySemantics } from "./memory-semantic-extractor.js";
import { processNextMemoryThreadDiscovery } from "./memory-thread-discovery-worker.js";

function diagnosticCode(error: unknown): string {
  return error instanceof AppError
    ? error.code
    : "AGENT_MEMORY_EXTRACTION_PROVIDER_FAILED";
}

export async function processNextMemoryExtraction(): Promise<boolean> {
  if (await processNextMemoryConsolidation()) return true;
  if (await processNextMemoryThreadDiscovery()) return true;
  return await productionMemoryExtractionWorker();
}

interface WorkerDependencies {
  catchUp(): Promise<number>;
  cleanup(): Promise<boolean>;
  extract: typeof extractMemorySemantics;
  processCandidates(batchId: string): Promise<number>;
  processPendingCandidates(): Promise<boolean>;
  repository: Pick<
    typeof memoryExtractionRepository,
    "claimPending" | "complete" | "fail" | "getBatch" | "markProviderCallStarted"
  >;
}

export function createMemoryExtractionWorker(dependencies: WorkerDependencies) {
  return async function processNext(): Promise<boolean> {
    if (await dependencies.cleanup()) return true;
    if (await dependencies.processPendingCandidates()) return true;
    await dependencies.catchUp();
    const job = await dependencies.repository.claimPending();
    if (!job) return false;
    // Resolve immutable PostgreSQL input before declaring that paid external work may have started.
    const batch = await dependencies.repository.getBatch(job.batchId);
    await dependencies.repository.markProviderCallStarted(job.id, job.leaseToken);
    let decisions: Awaited<ReturnType<WorkerDependencies["extract"]>>;
    try {
      decisions = await dependencies.extract({
        entries: batch.snapshotEntries.map((entry) => ({
          actorKind: entry.actorKind,
          actorLabel: entry.actorLabel,
          content: entry.contentText,
          observedAt: entry.observedAt,
          participantRef: entry.participantRef,
          replyToSourceRef: entry.replyToSourceRef,
          snapshotEntryId: entry.id,
          sourceRef: entry.sourceRef,
        })),
      });
    } catch (error) {
      await dependencies.repository.fail(job.id, job.leaseToken, diagnosticCode(error));
      console.error(JSON.stringify({
        batchId: job.batchId,
        code: diagnosticCode(error),
        error: error instanceof Error ? error.message : String(error),
        jobId: job.id,
      }));
      // The exact job is terminal and cannot benefit from a process restart or another provider call.
      return true;
    }
    // Persistence ambiguity must stop the process; it cannot be rewritten as a provider failure.
    await dependencies.repository.complete({
      decisions,
      diagnosticCode: null,
      jobId: job.id,
      leaseToken: job.leaseToken,
      partialResults: false,
    });
    // Candidate writes have their own idempotent recovery scan and never rewrite provider state.
    await dependencies.processCandidates(job.batchId);
    return true;
  };
}

const productionMemoryExtractionWorker = createMemoryExtractionWorker({
  catchUp: createCatchUpExtractionBatches,
  cleanup: memoryExtractionRepository.cleanupNextResolvedSnapshot,
  extract: extractMemorySemantics,
  processCandidates: processMemoryExtractionCandidates,
  processPendingCandidates: processNextPendingMemoryExtractionCandidates,
  repository: memoryExtractionRepository,
});
