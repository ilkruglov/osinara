/**
 * Waiting for the hook of a session run Eve has just started.
 *
 * Constructs covered:
 * - A hook that appears after Eve's own wait gave up is still found while the run is alive.
 * - A run that ended without its hook, or a wait past the ceiling, fails with an error of its own,
 *   never `HookNotFoundError`: the ingress reads that name as «not delivered» and requeues, while
 *   this run already holds the message (Codex review, 6 November 2026).
 * - Any other error goes back at once.
 */
import { describe, expect, it, vi } from "vitest";

import { waitForStartedRunHook } from "./started-run-hook.js";

const missing = () => Object.assign(new Error("hook not found"), { name: "HookNotFoundError" });
const isHookMissing = (error: unknown) =>
  error instanceof Error && error.name === "HookNotFoundError";

describe("waitForStartedRunHook", () => {
  it("keeps waiting while the run is alive and returns the hook once it appears", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(missing())
      .mockRejectedValueOnce(missing())
      .mockResolvedValueOnce({ runId: "wrun_1" });
    const runStatus = vi.fn().mockResolvedValueOnce("pending").mockResolvedValueOnce("running");

    await expect(
      waitForStartedRunHook({ attempt, isHookMissing, runId: "wrun_1", runStatus }),
    ).resolves.toEqual({ runId: "wrun_1" });
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it.each(["failed", "cancelled", "completed"])(
    "fails on its own error when the run is %s without a hook",
    async (status) => {
      const attempt = vi.fn().mockRejectedValue(missing());

      const failure = await waitForStartedRunHook({
        attempt,
        isHookMissing,
        runId: "wrun_1",
        runStatus: async () => status,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).name).toBe("EveStartedRunHookError");
      expect((failure as Error).message).toContain("AGENT_EVE_SESSION_HOOK_UNAVAILABLE");
      expect((failure as Error).message).toContain(status);
      expect(attempt).toHaveBeenCalledOnce();
    },
  );

  it("gives up after the ceiling with its own error", async () => {
    let at = 0;
    const attempt = vi.fn(async () => {
      at += 30_000;
      throw missing();
    });

    const failure = await waitForStartedRunHook({
      attempt,
      isHookMissing,
      now: () => at,
      runId: "wrun_1",
      runStatus: async () => "pending",
      timeoutMs: 100_000,
    }).catch((error: unknown) => error);

    expect((failure as Error).name).toBe("EveStartedRunHookError");
    expect(attempt).toHaveBeenCalledTimes(4);
  });

  it("returns any other error at once", async () => {
    const conflict = Object.assign(new Error("owned by another run"), {
      name: "RuntimeSessionOwnershipConflictError",
    });
    const runStatus = vi.fn();

    await expect(
      waitForStartedRunHook({
        attempt: async () => {
          throw conflict;
        },
        isHookMissing,
        runId: "wrun_1",
        runStatus,
      }),
    ).rejects.toBe(conflict);
    expect(runStatus).not.toHaveBeenCalled();
  });
});
