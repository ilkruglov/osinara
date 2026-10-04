/**
 * Bounded warm-cache reconciliation for disposable sandbox compute.
 *
 * Exports:
 * - `SandboxReconciliationResult`: stopped/removed counts for operational logging.
 * - `reconcileSandboxContainers`: stops idle compute and removes expired or excess warm entries.
 * - `makeRoomForContainer`: keeps running compute under the configured cap before a new start.
 * - Warm retention constants: explicit resource bounds independent of environment variables.
 */
import type Docker from "dockerode";

import type { SandboxActivityRegistry } from "./docker-sandbox-lifecycle.js";

const SANDBOX_STOPPED_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const SANDBOX_STOPPED_CACHE_MAX = 16;
const SANDBOX_STOP_TIMEOUT_SECONDS = 5;

const SANDBOX_SESSION_LABEL = "dev.osinara.sandbox.session-id";
const SANDBOX_PROJECT_LABEL = "dev.osinara.sandbox.project";

export interface SandboxReconciliationResult {
  removed: number;
  stopped: number;
}

interface StoppedContainer {
  container: Docker.Container;
  finishedAtMs: number;
  id: string;
  sessionId: string;
}

function requireFinishedAt(value: string | undefined, id: string): number {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    throw new Error(
      `AGENT_SANDBOX_RUNNER_STATE_INVALID: Stopped container ${id} has no completion time`,
    );
  }
  return timestamp;
}

/**
 * Makes room for one more running container under `limit`: below it nothing happens; at it the
 * least recently used container that has been idle for `minIdleMs` is stopped (its session
 * resumes with a warm start on the next command); with every container in use there is no room.
 */
export async function makeRoomForContainer(input: {
  activity: SandboxActivityRegistry;
  docker: Docker;
  /** The session about to start: its own container, if listed, is neither counted nor stopped. */
  exceptSessionId?: string;
  limit: number;
  minIdleMs: number;
  nowMs: number;
  project: string;
}): Promise<{ room: boolean; running: number }> {
  const running = (await input.docker.listContainers({
    filters: {
      label: [SANDBOX_SESSION_LABEL, `${SANDBOX_PROJECT_LABEL}=${input.project}`],
      status: ["running"],
    },
  })).map((item) => ({ id: item.Id, sessionId: item.Labels[SANDBOX_SESSION_LABEL] }))
    .filter((item): item is { id: string; sessionId: string } =>
      typeof item.sessionId === "string" && item.sessionId !== input.exceptSessionId);
  if (running.length < input.limit) return { room: true, running: running.length };
  // A session this process has never seen is the coldest of all.
  const byLastUse = running
    .map((item) => ({ ...item, lastUsedAt: input.activity.lastActivityAt(item.sessionId) ?? Number.NEGATIVE_INFINITY }))
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
  for (const item of byLastUse) {
    const stopped = await input.activity.removeIfIdle(item.sessionId, input.nowMs - input.minIdleMs, async () => {
      await stopContainer(input.docker.getContainer(item.id));
    });
    if (stopped) return { room: true, running: running.length - 1 };
  }
  return { room: false, running: running.length };
}

/** Stops a container; one already stopped (304) or gone (404) by the idle sweep counts as stopped. */
async function stopContainer(container: Docker.Container): Promise<void> {
  try {
    await container.stop({ t: SANDBOX_STOP_TIMEOUT_SECONDS });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "statusCode" in error
      ? Number(error.statusCode)
      : undefined;
    if (status !== 304 && status !== 404) throw error;
  }
}

export async function reconcileSandboxContainers(input: {
  activity: SandboxActivityRegistry;
  docker: Docker;
  idleCutoffMs: number;
  nowMs: number;
  project: string;
}): Promise<SandboxReconciliationResult> {
  const listed = await input.docker.listContainers({
    all: true,
    filters: {
      label: [SANDBOX_SESSION_LABEL, `${SANDBOX_PROJECT_LABEL}=${input.project}`],
    },
  });
  const running = listed.filter((item) => item.State === "running");
  const stopped = await Promise.all(listed.filter((item) => item.State !== "running").map(
    async (item): Promise<StoppedContainer | null> => {
      const sessionId = item.Labels[SANDBOX_SESSION_LABEL];
      if (typeof sessionId !== "string") return null;
      const container = input.docker.getContainer(item.Id);
      const inspection = await container.inspect();
      return {
        container,
        finishedAtMs: requireFinishedAt(inspection.State.FinishedAt, item.Id),
        id: item.Id,
        sessionId,
      };
    },
  ));
  const stoppedContainers = stopped.filter((item): item is StoppedContainer => item !== null)
    .sort((left, right) => left.finishedAtMs - right.finishedAtMs);
  const excess = Math.max(0, stoppedContainers.length - SANDBOX_STOPPED_CACHE_MAX);
  const retentionCutoffMs = input.nowMs - SANDBOX_STOPPED_RETENTION_MS;
  const removalIds = new Set(stoppedContainers
    .filter((item, index) => item.finishedAtMs <= retentionCutoffMs || index < excess)
    .map((item) => item.id));

  // Stop only through the activity gate so an arriving command cannot race the transition.
  const stopResults = await Promise.all(running.map(async (item) => {
    const sessionId = item.Labels[SANDBOX_SESSION_LABEL];
    if (typeof sessionId !== "string") return false;
    return await input.activity.removeIfIdle(sessionId, input.idleCutoffMs, async () => {
      await stopContainer(input.docker.getContainer(item.Id));
    });
  }));

  // Recently stopped containers form the bounded warm cache; only expired or excess entries leave it.
  const removeResults = await Promise.all(stoppedContainers.map(async (item) => {
    if (!removalIds.has(item.id)) return false;
    return await input.activity.removeIfIdle(item.sessionId, input.idleCutoffMs, async () => {
      await item.container.remove({ force: true, v: true }).catch((error) => {
        const status = typeof error === "object" && error !== null && "statusCode" in error
          ? Number(error.statusCode)
          : undefined;
        if (status !== 404) throw error;
      });
    });
  }));
  return {
    removed: removeResults.filter(Boolean).length,
    stopped: stopResults.filter(Boolean).length,
  };
}
