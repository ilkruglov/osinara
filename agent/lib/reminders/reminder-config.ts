/**
 * Reminder product and dispatcher limits.
 *
 * Exports:
 * - Named content, pagination, recurrence, batch, lease, and lateness constants.
 * - External-group reminder timezone and the per-author and per-chat live reminder caps.
 */
export const REMINDER_CONTENT_MAX_LENGTH = 1_000;
export const REMINDER_LIST_DEFAULT_LIMIT = 100;
export const REMINDER_LIST_MAX_LIMIT = 100;
export const REMINDER_RECURRENCE_INTERVAL_MAX = 365;
export const REMINDER_DISPATCH_BATCH_SIZE = 25;
export const REMINDER_DISPATCH_LEASE_MILLISECONDS = 5 * 60_000;
export const REMINDER_DISPATCH_LATE_AFTER_MILLISECONDS = 90_000;
export const REMINDER_DISPATCH_MAX_SAFE_ATTEMPTS = 3;
export const REMINDER_RECURRENCE_MAX_SKIPPED_OCCURRENCES = 100_000;

// A participant of an external group has no account and therefore no personal timezone. Public
// group reminders are interpreted in one product-wide zone instead, so no chat needs configuring.
export const GROUP_REMINDER_TIMEZONE = "Europe/Moscow";
// A reminder of a public chat belongs to the chat, so the only quota is the shared one.
export const GROUP_REMINDER_MAX_PER_CHAT = 30;

// A recurring reminder is anchored to its first run, and every missed occurrence between the anchor
// and now is walked once inside the delivery transaction. A public chat holds people the owner did
// not vet, so a far past anchor stays out of reach instead of relying on the occurrence cap alone.
export const GROUP_REMINDER_MAX_BACKDATE_MS = 24 * 60 * 60_000;
