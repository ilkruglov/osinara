/**
 * The minute tick of person cards.
 *
 * Constructs covered:
 * - Queueing goes before purging, so a card left with nothing standing gets its rebuild first.
 * - Builds are started and not awaited: a long build never holds the next tick.
 */
import { describe, expect, it, vi } from "vitest";

import { dispatchPersonCards } from "./person-card-dispatcher.js";

describe("dispatchPersonCards", () => {
  it("queues before purging and returns without waiting for the builds", async () => {
    const order: string[] = [];
    let finishBuild: () => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishBuild = resolve;
        }),
    );
    await dispatchPersonCards({
      queue: {
        claim: vi.fn(async () => {
          order.push("claim");
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
      },
      run,
    });
    expect(order).toEqual(["reclaim", "enqueue", "purge", "claim"]);
    expect(run).toHaveBeenCalledTimes(1);
    finishBuild();
  });
});
