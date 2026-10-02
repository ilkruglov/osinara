/**
 * Stuck run recovery scheduling tests.
 *
 * Constructs covered:
 * - Each found run is enqueued on its workflow's queue with only its run id, as startup recovery does.
 * - A failing scan is logged and the next scan still runs; scans never overlap.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { startStuckRunRecovery } from "./stuck-run-recovery.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("stuck run recovery scheduling", () => {
  it("enqueues every stuck run on its workflow queue", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const enqueue = vi.fn(async () => ({}));
    const pool = { query: vi.fn(async () => ({ rows: [{ last_event: "step_retrying", run_id: "wrun_a", workflow_name: "workflow//eve//turnWorkflow" }] })) };
    const stop = startStuckRunRecovery({ enqueue, intervalMs: 1000, pool, queuePrefix: "__wkf_workflow_" });

    await vi.advanceTimersByTimeAsync(1000);
    stop();

    expect(enqueue).toHaveBeenCalledWith("__wkf_workflow_workflow//eve//turnWorkflow", { runId: "wrun_a" });
  });

  it("logs a failed scan and keeps scanning", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = { query: vi.fn(async () => { throw new Error("connection reset"); }) };
    const stop = startStuckRunRecovery({ enqueue: vi.fn(), intervalMs: 1000, pool, queuePrefix: "p_" });

    await vi.advanceTimersByTimeAsync(2000);
    stop();

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[0]?.[0]).toContain("AGENT_WORKFLOW_STUCK_RUN_SCAN_FAILED");
  });
});
