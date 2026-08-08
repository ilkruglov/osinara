/**
 * Terminal-attempt memory-thread discovery worker orchestration.
 *
 * Exports:
 * - `createMemoryThreadDiscoveryWorker`: injectable recovery staging and one classifier attempt.
 * - `processNextMemoryThreadDiscovery`: production step for the existing extraction worker loop.
 */
import { AppError } from "./app-error.js";
import { classifyMemoryThread } from "./memory-thread-classifier.js";
import { memoryThreadDiscoveryRepository } from "./memory-thread-discovery-repository.js";

interface DiscoveryWorkerDependencies {
  classify: typeof classifyMemoryThread;
  repository: typeof memoryThreadDiscoveryRepository;
}

function diagnosticCode(error: unknown): string {
  return error instanceof AppError
    ? error.code
    : "AGENT_MEMORY_THREAD_DISCOVERY_PROVIDER_FAILED";
}

export function createMemoryThreadDiscoveryWorker(dependencies: DiscoveryWorkerDependencies) {
  return async function processNext(): Promise<boolean> {
    const job = await dependencies.repository.claimPending();
    if (!job) {
      if (await dependencies.repository.stageNextImmediateCandidate()) return true;
      return await dependencies.repository.stageRecoveryCandidate();
    }
    // Durable source/thread refs are loaded before the marker that makes provider work ambiguous.
    const input = await dependencies.repository.loadClassifierInput(job.id);
    await dependencies.repository.markProviderCallStarted(job.id, job.leaseToken);
    try {
      const decision = await dependencies.classify(input);
      await dependencies.repository.complete(job.id, job.leaseToken, decision);
      return true;
    } catch (error) {
      await dependencies.repository.fail(job.id, job.leaseToken, diagnosticCode(error));
      console.error(JSON.stringify({
        code: diagnosticCode(error),
        error: error instanceof Error ? error.message : String(error),
        jobId: job.id,
      }));
      throw error;
    }
  };
}

export const processNextMemoryThreadDiscovery = createMemoryThreadDiscoveryWorker({
  classify: classifyMemoryThread,
  repository: memoryThreadDiscoveryRepository,
});
