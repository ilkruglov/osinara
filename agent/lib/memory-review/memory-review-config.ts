/**
 * Stable memory-review runtime configuration.
 *
 * Exports:
 * - Batch size, dispatch/alert leases, bounded recovery, stale timeout, and claim bounds.
 */
export const MEMORY_REVIEW_BATCH_SIZE = 50;
export const MEMORY_REVIEW_DISPATCH_BATCH_SIZE = 10;
export const MEMORY_REVIEW_DISPATCH_LEASE_MILLISECONDS = 15 * 60 * 1_000;
export const MEMORY_REVIEW_INTERACTIVE_START_TIMEOUT_MILLISECONDS = 15 * 60 * 1_000;
export const MEMORY_REVIEW_MAX_SAFE_RECOVERY_ATTEMPTS = 1;
export const MEMORY_REVIEW_OWNER_ALERT_BATCH_SIZE = 10;
export const MEMORY_REVIEW_OWNER_ALERT_LEASE_MILLISECONDS = 15 * 60 * 1_000;
