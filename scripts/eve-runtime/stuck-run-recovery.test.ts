/**
 * Stuck run recovery scheduling tests.
 *
 * Constructs covered:
 * - Each found run is enqueued on its workflow's queue with only its run id, as startup recovery does.
 * - A failing scan is logged and the next scan still runs; scans never overlap.
 * - A run found in the same state again (a turn waiting on an approval or a child) is not replayed on
 *   every pass, only once per state and again after an hour (/code-review of 1.8.57–1.8.58).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  releaseDeadWorkerLocks,
  startStuckRunRecovery,
  STUCK_REQUEUE_REPEAT_AFTER_MS,
} from "./stuck-run-recovery.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("stuck run recovery scheduling", () => {
  it("enqueues every stuck run on its workflow queue", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const enqueue = vi.fn(async () => ({}));
    const pool = {
      query: vi.fn(async () => ({
        rows: [
          {
            last_event: "step_retrying",
            run_id: "wrun_a",
            workflow_name: "workflow//eve//turnWorkflow",
          },
        ],
      })),
    };
    const stop = startStuckRunRecovery({
      enqueue,
      intervalMs: 1000,
      pool,
      queuePrefix: "__wkf_workflow_",
    });

    await vi.advanceTimersByTimeAsync(1000);
    stop();

    expect(enqueue).toHaveBeenCalledWith("__wkf_workflow_workflow//eve//turnWorkflow", {
      runId: "wrun_a",
    });
  });

  /** A pool that leaves out the runs the query is told to skip, as the SQL does. */
  function skippingPool(rows: () => Array<Record<string, string>>) {
    return {
      query: vi.fn(async (_text: string, values?: unknown[]) => {
        const runIds = (values?.[4] ?? []) as string[];
        const eventIds = (values?.[5] ?? []) as string[];
        return {
          rows: rows().filter(
            (row) =>
              !runIds.some(
                (runId, index) => runId === row.run_id && eventIds[index] === row.last_event_id,
              ),
          ),
        };
      }),
    };
  }

  it("replays a run that only waits once per state, not on every pass", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const enqueue = vi.fn(async () => ({}));
    let lastEventId = "evnt_1";
    const pool = skippingPool(() => [
      {
        last_event: "step_completed",
        last_event_id: lastEventId,
        run_id: "wrun_waiting",
        workflow_name: "workflow//eve//turnWorkflow",
      },
    ]);
    let at = 0;
    const stop = startStuckRunRecovery({
      enqueue,
      intervalMs: 1000,
      now: () => at,
      pool,
      queuePrefix: "p_",
    });

    // The replay went back to the same wait: no new event, so the next passes leave it alone, in
    // the query itself, so it takes none of the scan's places from other runs.
    await vi.advanceTimersByTimeAsync(3000);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls.at(-1)![1]!.slice(4)).toEqual([["wrun_waiting"], ["evnt_1"]]);

    // A new last event is a new state, replayed once again.
    lastEventId = "evnt_2";
    await vi.advanceTimersByTimeAsync(1000);
    expect(enqueue).toHaveBeenCalledTimes(2);

    // The same state an hour later: the requeued job itself may have been lost, so it goes again.
    at += STUCK_REQUEUE_REPEAT_AFTER_MS;
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    expect(enqueue).toHaveBeenCalledTimes(3);
  });

  // /code-review of the fix, 9 November 2026: the hour's skip held a retry whose requeued job was
  // lost again (1 October 2026), so the chat stayed silent an hour instead of one more pass.
  it.each([
    ["a turn left on a retry", "step_retrying", "workflow//eve//turnWorkflow"],
    ["another workflow after a completed step", "step_completed", "workflow//eve//workflowEntry"],
  ])(
    "requeues %s on every pass: only a turn after a completed step may be waiting",
    async (_name, lastEvent, workflowName) => {
      vi.useFakeTimers();
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const enqueue = vi.fn(async () => ({}));
      const pool = skippingPool(() => [
        {
          last_event: lastEvent,
          last_event_id: "evnt_retry",
          run_id: "wrun_retry",
          workflow_name: workflowName,
        },
      ]);
      const stop = startStuckRunRecovery({ enqueue, intervalMs: 1000, pool, queuePrefix: "p_" });

      await vi.advanceTimersByTimeAsync(3000);
      stop();

      expect(enqueue).toHaveBeenCalledTimes(3);
    },
  );

  // /code-review of the fix, 9 November 2026: the runs were remembered only after a whole scan.
  it("remembers a run as soon as it is requeued, even when a later one fails", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const enqueued: string[] = [];
    let failB = true;
    const enqueue = vi.fn(async (_queue: string, message: { runId: string }) => {
      if (message.runId === "wrun_b" && failB) {
        failB = false;
        throw new Error("connection reset");
      }
      enqueued.push(message.runId);
      return {};
    });
    const row = (runId: string) => ({
      last_event: "step_completed",
      last_event_id: `${runId}-event`,
      run_id: runId,
      workflow_name: "workflow//eve//turnWorkflow",
    });
    const pool = skippingPool(() => [row("wrun_a"), row("wrun_b")]);
    const stop = startStuckRunRecovery({ enqueue, intervalMs: 1000, pool, queuePrefix: "p_" });

    await vi.advanceTimersByTimeAsync(2000);
    stop();

    expect(enqueued).toEqual(["wrun_a", "wrun_b"]);
  });

  it("logs a failed scan and keeps scanning", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = {
      query: vi.fn(async () => {
        throw new Error("connection reset");
      }),
    };
    const stop = startStuckRunRecovery({
      enqueue: vi.fn(),
      intervalMs: 1000,
      pool,
      queuePrefix: "p_",
    });

    await vi.advanceTimersByTimeAsync(2000);
    stop();

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[0]?.[0]).toContain("AGENT_WORKFLOW_STUCK_RUN_SCAN_FAILED");
  });
});

describe("releaseDeadWorkerLocks", () => {
  it("frees the locks older than this process's start and reports how many workers held them", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        return { rows: [{ workers: "2" }] };
      },
    };
    const startedAt = new Date("2026-10-05T14:31:57Z");
    await expect(releaseDeadWorkerLocks(pool, startedAt)).resolves.toBe(2);
    expect(queries[0]!.values).toEqual([startedAt]);
    expect(queries[0]!.text).toContain("graphile_worker.force_unlock_workers");
    expect(queries[0]!.text).toContain("_private_job_queues");
  });
});
