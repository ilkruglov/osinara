/**
 * Stable memory-review runtime configuration.
 *
 * Exports:
 * - Batch size, dispatch/alert leases, bounded recovery, stale timeout, and claim bounds.
 */
export const MEMORY_REVIEW_BATCH_SIZE = 50;
export const MEMORY_REVIEW_DISPATCH_BATCH_SIZE = 10;
// Idle review: a lane is reviewed after ten minutes of silence or once ten sources accumulate.
export const MEMORY_REVIEW_IDLE_MILLISECONDS = 10 * 60 * 1_000;
export const MEMORY_REVIEW_IDLE_MIN_SOURCES = 10;
// Existing claims shown to the review so it versions slots instead of duplicating.
export const MEMORY_REVIEW_CONTEXT_LIMIT = 40;
export const MEMORY_REVIEW_DISPATCH_LEASE_MILLISECONDS = 15 * 60 * 1_000;
export const MEMORY_REVIEW_INTERACTIVE_START_TIMEOUT_MILLISECONDS = 15 * 60 * 1_000;
export const MEMORY_REVIEW_MAX_SAFE_RECOVERY_ATTEMPTS = 1;
export const MEMORY_REVIEW_OWNER_ALERT_BATCH_SIZE = 10;
export const MEMORY_REVIEW_OWNER_ALERT_LEASE_MILLISECONDS = 15 * 60 * 1_000;
