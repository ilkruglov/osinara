/**
 * Docker sandbox lifecycle identity and activity tracking.
 *
 * Exports:
 * - `SANDBOX_IDLE_SWEEP_INTERVAL_MS`: cadence for bounded idle reconciliation.
 * - `SANDBOX_IDLE_TIMEOUT_MS`: inactivity window before compute is stopped.
 * - `createSandboxActivityRegistry`: tracks active work and serializes session creation.
 * - `sandboxContainerName`: deterministic physical name for a stable conversation thread.
 * - `sandboxContainerNeedsReplacement`: detects stale owner or policy identity.
 * - `sandboxRequestHash`: stable policy identity independent of transient Eve roots.
 * - Activity gates prevent idle stop/removal from racing with newly arriving work.
 */
import { createHash } from "node:crypto";

import { integerSetting } from "../../agent/lib/runtime-tuning.js";
import type { SandboxRunnerCreateRequest } from "../../agent/lib/sandbox-runner/sandbox-runner-contract.js";
import { SANDBOX_CONTAINER_POLICY_VERSION } from "./docker-sandbox-options.js";

export const SANDBOX_IDLE_SWEEP_INTERVAL_MS = 60 * 1_000;
// An idle container costs under a megabyte of resident memory but its file cache and a cold
// start of about three seconds on the next command (load stand, 4 October 2026), so the window
// is tunable: one family keeps its container warm for hours, a thousand families on one machine
// want minutes so that only the chats of the last few minutes hold a container.
export const SANDBOX_IDLE_TIMEOUT_MS = integerSetting(
  "SANDBOX_IDLE_TIMEOUT_MS",
  { absent: 30 * 60 * 1_000, min: 60 * 1_000, max: 24 * 60 * 60 * 1_000 },
);
// The idle window alone lets as many containers run as chats were active inside it; on one
// machine for many families the cap below bounds them: a new container at the cap first stops
// the least recently used one that has been quiet for a minute, and when every container is
// in use the command is refused rather than the host overcommitted (5 October 2026).
export const SANDBOX_MAX_RUNNING_CONTAINERS = integerSetting(
  "SANDBOX_MAX_RUNNING_CONTAINERS",
  { absent: 1_000, min: 1, max: 100_000 },
);
export const SANDBOX_CAPACITY_MIN_IDLE_MS = 60 * 1_000;

const CONTAINER_PREFIX = "osinara-sandbox-";

interface ExistingSandboxIdentity {
  requestHash: string | undefined;
  sandboxSessionId: string | undefined;
}

export interface SandboxActivityRegistry {
  /** Operations of the session currently inside `runActive`, the caller's own included. */
  activeCount(sessionId: string): number;
  clear(): void;
  forget(sessionId: string): void;
  isIdle(sessionId: string, cutoffMs: number): boolean;
  /** When the session last started an operation in this process; undefined before the first. */
  lastActivityAt(sessionId: string): number | undefined;
  removeIfIdle(sessionId: string, cutoffMs: number, operation: () => Promise<void>): Promise<boolean>;
  /**
   * From inside `runActive`: runs the operation only while the caller's is the session's sole
   * operation, and new ones wait until it ends; false when another was running.
   */
  runAlone(sessionId: string, operation: () => Promise<void>): Promise<boolean>;
  runActive<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
  runExclusive<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
  touch(sessionId: string): void;
}

export function sandboxContainerName(sandboxSessionId: string): string {
  const id = createHash("sha256").update(sandboxSessionId).digest("hex").slice(0, 40);
  return `${CONTAINER_PREFIX}${id}`;
}

export function sandboxRequestHash(request: SandboxRunnerCreateRequest): string {
  // Mount ordering is not security-significant, while owner, access, and policy version are.
  const mounts = [...request.mounts].sort((left, right) =>
    `${left.mountPoint}:${left.workspaceId}`.localeCompare(`${right.mountPoint}:${right.workspaceId}`)
  );
  return createHash("sha256").update(JSON.stringify({
    access: request.access,
    mounts,
    policyVersion: SANDBOX_CONTAINER_POLICY_VERSION,
    sandboxSessionId: request.sandboxSessionId,
    seedDigest: request.seedDigest,
  })).digest("hex");
}

export function sandboxContainerNeedsReplacement(
  existing: ExistingSandboxIdentity,
  request: SandboxRunnerCreateRequest,
): boolean {
  return existing.sandboxSessionId !== request.sandboxSessionId ||
    existing.requestHash !== sandboxRequestHash(request);
}

export function createSandboxActivityRegistry(now: () => number): SandboxActivityRegistry {
  const activeCounts = new Map<string, number>();
  const creationLocks = new Map<string, Promise<void>>();
  const lastActivity = new Map<string, number>();
  const removalGates = new Map<string, Promise<void>>();
  // Held while a command's leftovers are killed: an operation entering then would start
  // processes the cleanup takes for strays (Codex review, 5 October 2026).
  const aloneGates = new Map<string, Promise<void>>();
  const isIdle = (sessionId: string, cutoffMs: number): boolean => {
    if ((activeCounts.get(sessionId) ?? 0) > 0) return false;
    const lastUsedAt = lastActivity.get(sessionId);
    return lastUsedAt === undefined || lastUsedAt <= cutoffMs;
  };

  return {
    activeCount(sessionId) {
      return activeCounts.get(sessionId) ?? 0;
    },
    clear() {
      activeCounts.clear();
      creationLocks.clear();
      lastActivity.clear();
    },
    forget(sessionId) {
      activeCounts.delete(sessionId);
      lastActivity.delete(sessionId);
    },
    isIdle(sessionId, cutoffMs) {
      return isIdle(sessionId, cutoffMs);
    },
    lastActivityAt(sessionId) {
      return lastActivity.get(sessionId);
    },
    async runActive<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
      // Register activity synchronously once no removal owns the ID, closing check/remove races.
      while (true) {
        const removal = removalGates.get(sessionId) ?? aloneGates.get(sessionId);
        if (removal) {
          await removal;
          continue;
        }
        activeCounts.set(sessionId, (activeCounts.get(sessionId) ?? 0) + 1);
        lastActivity.set(sessionId, now());
        break;
      }
      try {
        return await operation();
      } finally {
        const remaining = (activeCounts.get(sessionId) ?? 1) - 1;
        if (remaining === 0) activeCounts.delete(sessionId);
        else activeCounts.set(sessionId, remaining);
        lastActivity.set(sessionId, now());
      }
    },
    async runAlone(sessionId, operation) {
      // Checked and gated in one synchronous step, so no operation slips in between.
      if ((activeCounts.get(sessionId) ?? 0) > 1 || aloneGates.has(sessionId)) return false;
      let release!: () => void;
      aloneGates.set(sessionId, new Promise<void>((resolve) => {
        release = resolve;
      }));
      try {
        await operation();
        return true;
      } finally {
        aloneGates.delete(sessionId);
        release();
      }
    },
    async removeIfIdle(sessionId, cutoffMs, operation) {
      // Reserve the physical ID before awaiting Docker; new work waits and recreates afterwards.
      while (true) {
        const pending = removalGates.get(sessionId);
        if (pending) {
          await pending;
          continue;
        }
        if (!isIdle(sessionId, cutoffMs)) return false;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        removalGates.set(sessionId, gate);
        let removed = false;
        try {
          await operation();
          removed = true;
          return true;
        } finally {
          if (removed) lastActivity.delete(sessionId);
          if (removalGates.get(sessionId) === gate) removalGates.delete(sessionId);
          release();
        }
      }
    },
    async runExclusive<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
      // A non-rejecting tail preserves FIFO even when an earlier create operation fails.
      const predecessor = creationLocks.get(sessionId) ?? Promise.resolve();
      let release!: () => void;
      const tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      creationLocks.set(sessionId, tail);
      await predecessor;
      try {
        return await operation();
      } finally {
        release();
        if (creationLocks.get(sessionId) === tail) creationLocks.delete(sessionId);
      }
    },
    touch(sessionId) {
      lastActivity.set(sessionId, now());
    },
  };
}
