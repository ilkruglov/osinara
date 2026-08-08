/**
 * Memory extraction worker terminal-attempt tests.
 *
 * Constructs covered:
 * - Durable provider marker precedes the only call.
 * - Provider ambiguity fails terminally and is not selected/retried on the next worker pass.
 */
import { describe, expect, it, vi } from "vitest";

import { createMemoryExtractionWorker } from "./memory-extraction-worker.js";

describe("memory extraction worker", () => {
  it("marks an ambiguous provider failure and never calls the provider again", async () => {
    const extract = vi.fn().mockRejectedValue(new Error("connection closed after request"));
    const repository = {
      claimPending: vi.fn()
        .mockResolvedValueOnce({ attempt: 1, batchId: "batch-1", id: "job-1", leaseToken: "lease-1" })
        .mockResolvedValueOnce(null),
      complete: vi.fn(),
      fail: vi.fn(),
      getBatch: vi.fn().mockResolvedValue({
        id: "batch-1",
        inputPayloadHash: "hash",
        snapshotEntries: [],
        status: "leased",
      }),
      markProviderCallStarted: vi.fn(),
    };
    const worker = createMemoryExtractionWorker({
      catchUp: vi.fn().mockResolvedValue(0),
      cleanup: vi.fn().mockResolvedValue(false),
      extract,
      processCandidates: vi.fn(),
      processPendingCandidates: vi.fn().mockResolvedValue(false),
      repository: repository as never,
    });

    await expect(worker()).rejects.toThrowError("connection closed after request");
    await expect(worker()).resolves.toBe(false);

    expect(repository.markProviderCallStarted).toHaveBeenCalledBefore(extract);
    expect(repository.getBatch).toHaveBeenCalledBefore(repository.markProviderCallStarted);
    expect(repository.fail).toHaveBeenCalledWith(
      "job-1",
      "lease-1",
      "AGENT_MEMORY_EXTRACTION_PROVIDER_FAILED",
    );
    expect(extract).toHaveBeenCalledTimes(1);
    expect(repository.complete).not.toHaveBeenCalled();
  });
});
