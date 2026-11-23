/**
 * Person card limits and the kill switch.
 *
 * Exports:
 * - Rebuild thresholds, lease and model bounds, card and input budgets.
 * - `personCardsEnabled`: the environment switch that turns off showing and building cards.
 *
 * Key constructs (the owner's decisions of 21 and 23 November 2026):
 * - A card is built at most once a day, a failed build included; it is rebuilt after ten new
 *   records about the person, after any new record of the person's own words, or when a record an
 *   item cites no longer stands. A build for the person's own words waits two minutes, so the
 *   records of one silent review batch, written together, fold into one build; ten new records
 *   do not wait.
 * - A card's items are at most 1 250 rendered characters; cards and the profile block share the
 *   block's 6 000.
 */

export const PERSON_CARD_NEW_RECORDS_THRESHOLD = 10;
export const PERSON_CARD_REBUILD_INTERVAL_MILLISECONDS = 24 * 60 * 60 * 1_000;
export const PERSON_CARD_SELF_STATEMENT_QUIET_MILLISECONDS = 2 * 60 * 1_000;

// Builds run beside the chat on one small server: two at a time, each with a lease well past the
// model's own deadline, so a lease runs out only when the process is gone.
export const PERSON_CARD_MAX_RUNNING_BUILDS = 2;
export const PERSON_CARD_MODEL_TIMEOUT_MILLISECONDS = 10 * 60 * 1_000;
export const PERSON_CARD_LEASE_MILLISECONDS = 15 * 60 * 1_000;
export const PERSON_CARD_MAX_ATTEMPTS = 3;

// The items of a card as the turn renders them (escaped JSON); label, ref and date come on top.
export const PERSON_CARD_ITEMS_MAX_CHARACTERS = 1_250;
export const PERSON_CARD_ITEM_MAX_CHARACTERS = 300;
export const PERSON_CARD_MAX_ITEM_SOURCES = 12;
// The largest person on production (21 November 2026) has 968 records, 252 thousand characters;
// above the cap the newest records are kept.
export const PERSON_CARD_INPUT_MAX_CHARACTERS = 300_000;
export const PERSON_CARD_MAX_EPISODES = 40;

/** Absent or anything but an "off" word (false, 0, no, off) keeps cards on: shipped straight into turns. */
const SWITCHED_OFF = new Set(["0", "false", "no", "off"]);

export function personCardsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !SWITCHED_OFF.has(env.AGENT_PERSON_CARDS_ENABLED?.trim().toLowerCase() ?? "");
}
