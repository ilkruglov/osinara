-- The family owner can switch silent memory review off for one external group: on production
-- (3 October 2026) two external groups produced 97 % of all review batches, i.e. most model calls,
-- for chats where no family member needs the memory. Off stops new batches at every entry (inline
-- fiftieth message, idle dispatcher, addressed-turn tail); the lane cursor stays, so switching the
-- review back on reviews the backlog in batches of fifty.
ALTER TABLE telegram_groups
  ADD COLUMN memory_review_enabled boolean NOT NULL DEFAULT true;
