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
 */
import { PERSON_CARD_MAX_RUNNING_BUILDS } from "./person-card-config.js";
import {
  personCardDispatchRepository,
  type ClaimedPersonCardBuild,
} from "./person-card-dispatch-repository.js";
import { runPersonCardBuild } from "./person-card-builder.js";

export interface PersonCardDispatcherDependencies {
  queue: Pick<
    typeof personCardDispatchRepository,
    "claim" | "enqueueDue" | "purgeOrphans" | "reclaimExpired"
  >;
  run(build: ClaimedPersonCardBuild): Promise<void>;
}

export async function dispatchPersonCards(
  dependencies: PersonCardDispatcherDependencies = {
    queue: personCardDispatchRepository,
    run: (build) => runPersonCardBuild(build),
  },
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
  const claimed = await dependencies.queue.claim(PERSON_CARD_MAX_RUNNING_BUILDS);
  for (const build of claimed) void dependencies.run(build);
}
