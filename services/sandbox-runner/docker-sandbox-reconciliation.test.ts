/**
 * Bounded warm sandbox cache tests.
 *
 * Constructs covered:
 * - Recent stopped containers remain reusable.
 * - The oldest stopped containers are removed when the hard cache bound is exceeded.
 */
import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";

import { createSandboxActivityRegistry } from "./docker-sandbox-lifecycle.js";
import {
  makeRoomForContainer,
  reconcileSandboxContainers,
  SANDBOX_STOPPED_CACHE_MAX,
} from "./docker-sandbox-reconciliation.js";

const NOW_MS = Date.parse("2026-07-30T20:00:00.000Z");

describe("sandbox warm-cache reconciliation", () => {
  it("removes only the oldest recent containers above the hard cache bound", async () => {
    const count = SANDBOX_STOPPED_CACHE_MAX + 2;
    const removals = Array.from({ length: count }, () => vi.fn(async () => undefined));
    const listed = Array.from({ length: count }, (_, index) => ({
      Id: `container-${index}`,
      Labels: { "dev.osinara.sandbox.session-id": `session-${index}` },
      State: "exited",
    }));
    const docker = {
      getContainer: vi.fn((id: string) => {
        const index = Number(id.slice("container-".length));
        return {
          inspect: vi.fn(async () => ({
            State: {
              FinishedAt: new Date(NOW_MS - (count - index) * 60 * 60 * 1_000).toISOString(),
              Running: false,
            },
          })),
          remove: removals[index],
        };
      }),
      listContainers: vi.fn(async () => listed),
    } as unknown as Docker;

    await expect(reconcileSandboxContainers({
      activity: createSandboxActivityRegistry(() => NOW_MS),
      docker,
      idleCutoffMs: NOW_MS - 30 * 60 * 1_000,
      nowMs: NOW_MS,
      project: "osinara",
    })).resolves.toEqual({ removed: 2, stopped: 0 });

    expect(removals[0]).toHaveBeenCalledOnce();
    expect(removals[1]).toHaveBeenCalledOnce();
    expect(removals.slice(2).every((remove) => remove.mock.calls.length === 0)).toBe(true);
  });
});

describe("sandbox running-container cap", () => {
  const NOW_MS = Date.parse("2026-10-05T00:00:00.000Z");
  const running = (count: number) => Array.from({ length: count }, (_, index) => ({
    Id: `running-${index}`,
    Labels: { "dev.osinara.sandbox.session-id": `session-${index}` },
    State: "running",
  }));
  const dockerWith = (listed: unknown[], stops: Map<string, ReturnType<typeof vi.fn>>) => ({
    getContainer: vi.fn((id: string) => ({ stop: stops.get(id) ?? vi.fn(async () => undefined) })),
    listContainers: vi.fn(async () => listed),
  }) as unknown as Docker;

  it("leaves room below the cap without touching anything", async () => {
    const stops = new Map([["running-0", vi.fn(async () => undefined)]]);
    await expect(makeRoomForContainer({
      activity: createSandboxActivityRegistry(() => NOW_MS),
      docker: dockerWith(running(2), stops),
      limit: 3,
      minIdleMs: 60_000,
      nowMs: NOW_MS,
      project: "osinara",
    })).resolves.toEqual({ room: true, running: 2 });
    expect(stops.get("running-0")).not.toHaveBeenCalled();
  });

  it("stops the least recently used idle container at the cap", async () => {
    let clock = NOW_MS - 10 * 60_000;
    const activity = createSandboxActivityRegistry(() => clock);
    // session-1 was used ten minutes ago, session-2 just now, session-0 never in this process.
    await activity.runActive("session-1", async () => undefined);
    clock = NOW_MS;
    await activity.runActive("session-2", async () => undefined);
    const stops = new Map(["running-0", "running-1", "running-2"].map((id) => [id, vi.fn(async () => undefined)]));

    await expect(makeRoomForContainer({
      activity,
      docker: dockerWith(running(3), stops),
      limit: 3,
      minIdleMs: 60_000,
      nowMs: NOW_MS,
      project: "osinara",
    })).resolves.toEqual({ room: true, running: 2 });
    expect(stops.get("running-0")).toHaveBeenCalledOnce();
    expect(stops.get("running-1")).not.toHaveBeenCalled();
    expect(stops.get("running-2")).not.toHaveBeenCalled();
  });

  it("counts a container the idle sweep stopped meanwhile as stopped", async () => {
    const activity = createSandboxActivityRegistry(() => NOW_MS);
    const alreadyStopped = Object.assign(new Error("container already stopped"), { statusCode: 304 });
    const stops = new Map([["running-0", vi.fn(async () => Promise.reject(alreadyStopped))]]);

    await expect(makeRoomForContainer({
      activity,
      docker: dockerWith(running(1), stops),
      limit: 1,
      minIdleMs: 60_000,
      nowMs: NOW_MS,
      project: "osinara",
    })).resolves.toEqual({ room: true, running: 0 });
  });

  it("finds no room when every container at the cap was used within the minute", async () => {
    const activity = createSandboxActivityRegistry(() => NOW_MS);
    for (const session of ["session-0", "session-1"]) await activity.runActive(session, async () => undefined);
    const stops = new Map(["running-0", "running-1"].map((id) => [id, vi.fn(async () => undefined)]));

    await expect(makeRoomForContainer({
      activity,
      docker: dockerWith(running(2), stops),
      limit: 2,
      minIdleMs: 60_000,
      nowMs: NOW_MS,
      project: "osinara",
    })).resolves.toEqual({ room: false, running: 2 });
    expect([...stops.values()].every((stop) => stop.mock.calls.length === 0)).toBe(true);
  });
});
