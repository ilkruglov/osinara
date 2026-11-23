/**
 * The minute tick of person cards.
 *
 * Constructs covered:
 * - Queueing goes before purging, so a card left with nothing standing gets its rebuild first.
 * - Builds are started and not awaited: a long build never holds the next tick.
 * - In DeepSeek's peak hours and with cards switched off nothing is claimed, so nothing is paid;
 *   the queue is kept as ever (owner, 23 November 2026).
 */
import { describe, expect, it, vi } from "vitest";

import { dispatchPersonCards } from "./person-card-dispatcher.js";

const OFF_PEAK = new Date("2026-11-24T12:00:00Z");
const PEAK = new Date("2026-11-24T07:00:00Z");

function queue(order: string[]) {
  return {
    claim: vi.fn(async () => {
      order.push("claim");
      return [];
    }),
    enqueueDue: vi.fn(async () => {
      order.push("enqueue");
      return [];
    }),
    purgeOrphans: vi.fn(async () => {
      order.push("purge");
      return 0;
    }),
    reclaimExpired: vi.fn(async () => {
      order.push("reclaim");
      return { failed: 0, retried: 0 };
    }),
  };
}

describe("dispatchPersonCards", () => {
  it.each([
    ["in DeepSeek's peak hours", PEAK, true],
    ["with cards switched off", OFF_PEAK, false],
  ])("keeps the queue but claims no build %s", async (_name, now, enabled) => {
    const order: string[] = [];
    await dispatchPersonCards({ enabled: () => enabled, queue: queue(order), run: vi.fn() }, now);
    expect(order).toEqual(["reclaim", "enqueue", "purge"]);
  });

  it("queues before purging and returns without waiting for the builds", async () => {
    const order: string[] = [];
    const limits: number[] = [];
    let finishBuild: () => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishBuild = resolve;
        }),
    );
    await dispatchPersonCards(
      {
        enabled: () => true,
        queue: {
          ...queue(order),
          claim: vi.fn(async (limit: number) => {
            order.push("claim");
            limits.push(limit);
            return [
              {
                attempts: 1,
                id: "build-1",
                key: {
                  area: "group" as const,
                  areaKey: "g",
                  familyId: "f",
                  subjectTelegramUserId: "1",
                },
                leaseToken: "lease",
                reason: "new_records" as const,
              },
            ];
          }),
        },
        run,
      },
      OFF_PEAK,
    );
    expect(order).toEqual(["reclaim", "enqueue", "purge", "claim"]);
    // Outside DeepSeek's peak hours the tick takes builds to run.
    expect(limits[0]).toBeGreaterThan(0);
    expect(run).toHaveBeenCalledTimes(1);
    finishBuild();
  });
});
