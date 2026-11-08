/**
 * Waiting for the hook of a session run Eve has just started (vendored Eve,
 * `execution/workflow-runtime.js`, `createSession`).
 *
 * Export:
 * - `waitForStartedRunHook`: repeats Eve's bounded wait for the hook while the run is alive.
 *
 * Key construct:
 * - Eve starts the session run with the message as its input, then waits 30 seconds for the run's
 *   hook. When the Workflow queue lags, the hook comes later and Eve threw `HookNotFoundError`; the
 *   Telegram ingress reads that name as «the session refused the message», requeued it, and the
 *   requeued copy was taken for a duplicate and completed while the started run still answered, so
 *   the chat's next message ran beside it (Codex review, 6 November 2026). The run holds the message
 *   from its start, so the wait goes on while the run is pending or running, up to five minutes; a
 *   run that ended without its hook, or a wait past the ceiling, fails with `EveStartedRunHookError`.
 */
const STARTED_RUN_HOOK_TIMEOUT_MS = 5 * 60 * 1000;
const LIVE_RUN_STATUSES = new Set(["pending", "running"]);

function startedRunHookError(runId: string, reason: string, cause: unknown): Error {
  const error = new Error(
    `AGENT_EVE_SESSION_HOOK_UNAVAILABLE: the started run ${runId} has no hook (${reason})`,
    { cause },
  );
  error.name = "EveStartedRunHookError";
  return error;
}

export async function waitForStartedRunHook<T>(input: {
  /** One bounded wait for the hook: Eve's own, which throws when the hook is not there yet. */
  attempt: () => Promise<T>;
  isHookMissing: (error: unknown) => boolean;
  now?: () => number;
  runId: string;
  runStatus: () => Promise<string>;
  timeoutMs?: number;
}): Promise<T> {
  const now = input.now ?? Date.now;
  const deadline = now() + (input.timeoutMs ?? STARTED_RUN_HOOK_TIMEOUT_MS);
  for (;;) {
    try {
      return await input.attempt();
    } catch (error) {
      if (!input.isHookMissing(error)) throw error;
      const status = await input.runStatus();
      if (!LIVE_RUN_STATUSES.has(status))
        throw startedRunHookError(input.runId, `run ${status}`, error);
      if (now() >= deadline)
        throw startedRunHookError(input.runId, "still pending after the wait", error);
    }
  }
}
