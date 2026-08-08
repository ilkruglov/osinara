/**
 * Graceful memory worker shutdown tests.
 *
 * Constructs covered:
 * - SIGTERM-style cancellation stops new claims but lets the current durable step settle.
 * - Database cleanup runs exactly once after the active step finishes.
 */
import { describe, expect, it, vi } from "vitest";

import { runMemoryWorkerLoop } from "./memory-worker-loop.js";

describe("memory worker loop", () => {
  it("finishes the active step before closing on cancellation", async () => {
    const controller = new AbortController();
    let finishStep!: () => void;
    const processNext = vi.fn(() => new Promise<boolean>((resolve) => {
      finishStep = () => resolve(true);
    }));
    const close = vi.fn();
    const running = runMemoryWorkerLoop({
      close,
      idleMilliseconds: 1,
      processNext,
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(processNext).toHaveBeenCalledTimes(1));
    controller.abort();
    finishStep();
    await running;

    expect(processNext).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
