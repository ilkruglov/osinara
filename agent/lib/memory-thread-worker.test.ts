/**
 * Memory-thread discovery worker integration tests.
 *
 * Constructs covered:
 * - Discovery runs inside the existing extraction/consolidation worker step.
 * - A provider failure is terminal and the same job is never retried implicitly.
 */
import { describe, expect, it, vi } from "vitest";

import { createMemoryThreadDiscoveryWorker } from "./memory-thread-discovery-worker.js";

describe("memory thread discovery worker", () => {
  it("marks provider failure terminally and does not retry the job", async () => {
    const classify = vi.fn().mockRejectedValue(new Error("provider connection closed"));
    const repository = {
      claimPending: vi.fn()
        .mockResolvedValueOnce({ id: "job-1", leaseToken: "lease-1" })
        .mockResolvedValueOnce(null),
      complete: vi.fn(),
      fail: vi.fn(),
      loadClassifierInput: vi.fn().mockResolvedValue({ existingThreads: [], parentCandidates: [], sources: [] }),
      markProviderCallStarted: vi.fn(),
      stageNextImmediateCandidate: vi.fn().mockResolvedValue(false),
      stageRecoveryCandidate: vi.fn().mockResolvedValue(false),
    };
    const worker = createMemoryThreadDiscoveryWorker({ classify, repository: repository as never });

    await expect(worker()).rejects.toThrowError("provider connection closed");
    await expect(worker()).resolves.toBe(false);
    expect(repository.markProviderCallStarted).toHaveBeenCalledBefore(classify);
    expect(repository.loadClassifierInput).toHaveBeenCalledBefore(
      repository.markProviderCallStarted,
    );
    expect(repository.fail).toHaveBeenCalledWith(
      "job-1",
      "lease-1",
      "AGENT_MEMORY_THREAD_DISCOVERY_PROVIDER_FAILED",
    );
    expect(classify).toHaveBeenCalledTimes(1);
  });
});
