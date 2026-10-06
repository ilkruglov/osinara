/**
 * Stable memory-review runtime configuration.
 *
 * Exports:
 * - Batch size, dispatch/alert leases, bounded recovery, stale/abandoned bounds, claim bounds.
 */
import { integerSetting } from "../runtime-tuning.js";

/**
 * A running batch waits only for its own turn to report back. This bound is the last resort for a
 * turn that never does, so it must stay far above any real turn, including one that survives a
 * restart. Provenance, not this clock, decides what happens to the batch when it expires.
 */
export const MEMORY_REVIEW_ABANDONED_TURN_BATCH_SIZE = 10;
export const MEMORY_REVIEW_ABANDONED_TURN_TIMEOUT_MILLISECONDS = 60 * 60 * 1_000;
export const MEMORY_REVIEW_BATCH_SIZE = 50;
export const MEMORY_REVIEW_DISPATCH_BATCH_SIZE = 10;
// Reviews share the Workflow workers (30 on production) with the turns people wait for: at most
// this many background reviews run at once, and a claim takes only what the cap leaves. On one
// core a review in flight also takes the core from a live turn, so the cap is tunable: a
// single-family installation wants one or two, a thousand families the default.
export const MEMORY_REVIEW_MAX_IN_FLIGHT = integerSetting(
  "MEMORY_REVIEW_MAX_IN_FLIGHT",
  { absent: 10, min: 1, max: 100 },
);
// Lanes materialized per minute pass, so one transaction never spans every lane of a large
// installation; lanes left over qualify again on the next pass.
export const MEMORY_REVIEW_MATERIALIZE_LANE_LIMIT = integerSetting(
  "MEMORY_REVIEW_MATERIALIZE_LANE_LIMIT",
  { absent: 200, min: 1, max: 10_000 },
);
// Idle review: a lane is reviewed once ten sources accumulate, after ten minutes of silence with
// at least five sources, or after six hours of silence with anything at all. One or two messages
// on their own gave the model nothing to judge: production reviewed 607 messages in 108 batches
// (80 of them with one or two sources) and kept nine records.
export const MEMORY_REVIEW_IDLE_MILLISECONDS = 10 * 60 * 1_000;
export const MEMORY_REVIEW_IDLE_MIN_SOURCES = 10;
export const MEMORY_REVIEW_IDLE_MIN_BATCH_SOURCES = 5;
// External groups: no family member is in the chat, and on production (3 October 2026) two of them
// produced 97 % of all review batches, almost every one of exactly ten sources. Three times fewer
// calls for the same records; a record from such a chat reaches memory later.
export const MEMORY_REVIEW_EXTERNAL_IDLE_MILLISECONDS = 30 * 60 * 1_000;
export const MEMORY_REVIEW_EXTERNAL_IDLE_MIN_SOURCES = 30;
export const MEMORY_REVIEW_EXTERNAL_IDLE_MIN_BATCH_SOURCES = 10;
export const MEMORY_REVIEW_LONG_IDLE_MILLISECONDS = 6 * 60 * 60 * 1_000;
// A group tail shorter than this stays for idle review instead of riding the addressed turn.
export const MEMORY_REVIEW_INTERACTIVE_MIN_SOURCES = 8;
// Existing claims shown to the review so it versions slots instead of duplicating.
export const MEMORY_REVIEW_CONTEXT_LIMIT = 40;
// Slot names of one batch author shown to the review, most recently touched first: a subject in
// the largest group has 157 slots, which would be most of the prompt (6 October 2026).
export const MEMORY_REVIEW_SLOTS_PER_SUBJECT = 40;
// And across all subjects of a batch: the largest group's two-day authors come to 24 subjects
// and 431 slots, 8 000 characters, before this cap; the least recently touched slots go first.
export const MEMORY_REVIEW_SLOTS_TOTAL = 200;
// Already processed messages shown before a background batch so the tail reads in context.
export const MEMORY_REVIEW_PRECEDING_CONTEXT_LIMIT = 20;
export const MEMORY_REVIEW_DISPATCH_LEASE_MILLISECONDS = 15 * 60 * 1_000;
export const MEMORY_REVIEW_INTERACTIVE_START_TIMEOUT_MILLISECONDS = 15 * 60 * 1_000;
export const MEMORY_REVIEW_MAX_SAFE_RECOVERY_ATTEMPTS = 1;
export const MEMORY_REVIEW_OWNER_ALERT_BATCH_SIZE = 10;
export const MEMORY_REVIEW_OWNER_ALERT_LEASE_MILLISECONDS = 15 * 60 * 1_000;
