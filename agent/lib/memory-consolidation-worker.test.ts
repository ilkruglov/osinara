/**
 * Durable semantic consolidation worker tests.
 *
 * Constructs covered:
 * - Provider marker precedes the one classifier call.
 * - Provider failure becomes terminal and is never automatically selected again.
 */
import { describe, expect, it, vi } from "vitest";

import { createMemoryConsolidationWorker } from "./memory-consolidation-worker.js";

describe("memory consolidation worker", () => {
  it("marks provider failure terminally without an automatic retry", async () => {
    const classify = vi.fn().mockRejectedValue(new Error("provider closed after request"));
    const repository = {
      claimPending: vi.fn()
        .mockResolvedValueOnce({ id: "job-1", leaseToken: "lease-1" })
        .mockResolvedValueOnce(null),
      complete: vi.fn(),
      fail: vi.fn(),
      loadClassifierInput: vi.fn().mockResolvedValue({ existingCandidates: [], newCandidates: [] }),
      markProviderCallStarted: vi.fn(),
    };
    const worker = createMemoryConsolidationWorker({ classify, repository: repository as never });

    await expect(worker()).rejects.toThrowError("provider closed after request");
    await expect(worker()).resolves.toBe(false);

    expect(repository.markProviderCallStarted).toHaveBeenCalledBefore(classify);
    expect(repository.loadClassifierInput).toHaveBeenCalledBefore(
      repository.markProviderCallStarted,
    );
    expect(repository.fail).toHaveBeenCalledWith(
      "job-1",
      "lease-1",
      "AGENT_MEMORY_CONSOLIDATION_PROVIDER_FAILED",
    );
    expect(classify).toHaveBeenCalledTimes(1);
    expect(repository.complete).not.toHaveBeenCalled();
  });

});
