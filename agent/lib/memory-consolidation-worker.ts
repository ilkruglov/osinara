/**
 * One-pass durable memory relation classifier orchestration.
 *
 * Exports:
 * - `createMemoryConsolidationWorker`: injectable terminal provider-attempt workflow.
 * - `processNextMemoryConsolidation`: production worker step used by extraction worker process.
 */
import { AppError } from "./app-error.js";
import { memoryConsolidationJobRepository } from "./memory-consolidation-job-repository.js";
import { classifyMemoryRelations } from "./memory-relation-classifier.js";

interface ConsolidationWorkerDependencies {
  classify: typeof classifyMemoryRelations;
  repository: typeof memoryConsolidationJobRepository;
}

function diagnosticCode(error: unknown): string {
  return error instanceof AppError
    ? error.code
    : "AGENT_MEMORY_CONSOLIDATION_PROVIDER_FAILED";
}

export function createMemoryConsolidationWorker(dependencies: ConsolidationWorkerDependencies) {
  return async function processNext(): Promise<boolean> {
    const job = await dependencies.repository.claimPending();
    if (!job) return false;
    // Classifier input is immutable job state and must be validated before provider ambiguity starts.
    const input = await dependencies.repository.loadClassifierInput(job.id);
    await dependencies.repository.markProviderCallStarted(job.id, job.leaseToken);
    try {
      const decisions = await dependencies.classify(input);
      const decision = decisions[0];
      if (!decision || decisions.length !== 1) {
        throw new AppError(
          "AGENT_MEMORY_CONSOLIDATION_OUTPUT_INVALID",
          "Classifier не вернул ровно одно решение для durable job",
        );
      }
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

export const processNextMemoryConsolidation = createMemoryConsolidationWorker({
  classify: classifyMemoryRelations,
  repository: memoryConsolidationJobRepository,
});
