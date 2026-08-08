/**
 * Unified durable memory extraction repository facade.
 *
 * Exports:
 * - Re-exported extraction contracts.
 * - `memoryExtractionRepository`: batch creation, job lifecycle, and completion operations.
 */
import { memoryExtractionBatchRepository } from "./memory-extraction-batch-repository.js";
import { memoryExtractionCompletionRepository } from "./memory-extraction-completion-repository.js";
import { memoryExtractionJobRepository } from "./memory-extraction-job-repository.js";

export type {
  CompletedMemoryExtraction,
  CreateMemoryExtractionBatchInput,
  LeasedMemoryExtractionJob,
  MemoryExtractionBatch,
  MemoryExtractionRange,
  MemoryExtractionSnapshotEntry,
} from "./memory-extraction-contract.js";

export const memoryExtractionRepository = {
  ...memoryExtractionBatchRepository,
  ...memoryExtractionCompletionRepository,
  ...memoryExtractionJobRepository,
};
