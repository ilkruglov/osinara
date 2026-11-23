/**
 * The minute tick of person cards.
 *
 * Exports:
 * - `PersonCardDispatcherDependencies`: the seams tests replace.
 * - `dispatchPersonCards`: reclaims dead leases, queues due people, drops cards nothing stands
 *   behind any more, claims up to the running limit and starts those builds.
 *
 * Key constructs:
 * - Queueing goes before purging: a card whose cited records are all gone gets its rebuild queued
 *   first, and a card with an open build is not purged.
 * - Builds are started, not awaited: Nitro does not run a task again while its last run is
 *   pending, so one long build would hold the second slot and the next ticks for minutes. Each
 *   build records its own outcome and never throws; a process that ends mid-build leaves a lease
 *   the next process reclaims.
 * - Nothing is claimed in DeepSeek's peak hours (twice the price) nor with cards switched off: the
 *   switch stopped showing them but left paid builds going (Fable review, 23 November 2026). The
 *   queue is kept either way; a build claimed before the peak finishes in it.
 */
import { isDeepSeekPeakHour } from "../deepseek/deepseek-peak-hours.js";
import { PERSON_CARD_MAX_RUNNING_BUILDS, personCardsEnabled } from "./person-card-config.js";
import {
  personCardDispatchRepository,
  type ClaimedPersonCardBuild,
} from "./person-card-dispatch-repository.js";
import { runPersonCardBuild } from "./person-card-builder.js";

export interface PersonCardDispatcherDependencies {
  enabled(): boolean;
  queue: Pick<
    typeof personCardDispatchRepository,
    "claim" | "enqueueDue" | "purgeOrphans" | "reclaimExpired"
  >;
  run(build: ClaimedPersonCardBuild): Promise<void>;
}

export async function dispatchPersonCards(
  dependencies: PersonCardDispatcherDependencies = {
    enabled: () => personCardsEnabled(),
    queue: personCardDispatchRepository,
    run: (build) => runPersonCardBuild(build),
  },
  now = new Date(),
): Promise<void> {
  const reclaimed = await dependencies.queue.reclaimExpired();
  const queued = await dependencies.queue.enqueueDue();
  const purged = await dependencies.queue.purgeOrphans();
  if (reclaimed.failed + reclaimed.retried + purged + queued.length > 0) {
    console.info(
      JSON.stringify({
        abandoned: reclaimed.failed,
        code: "AGENT_PERSON_CARD_QUEUE",
        purged,
        queued: queued.length,
        reasons: queued.map((entry) => entry.reason),
        reclaimed: reclaimed.retried,
      }),
    );
  }
  if (!dependencies.enabled() || isDeepSeekPeakHour(now)) return;
  const claimed = await dependencies.queue.claim(PERSON_CARD_MAX_RUNNING_BUILDS);
  for (const build of claimed) void dependencies.run(build);
}
