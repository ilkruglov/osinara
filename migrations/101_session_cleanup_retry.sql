-- A retention deletion that failed used to park its session forever: the claim skipped any row
-- carrying `cleanup_error_code`, and only a manual edit could clear it. The first cause was a
-- session run that stayed `running`, which the very next sweep would have resolved, yet 36 sessions
-- stood undeletable from 3 сентября 2026, each holding a Workflow run whose full event log every
-- agent start then re-read. The retry deadline lives in its own column because the lease pair is
-- constrained to be set or cleared together, and a failed row holds no lease.
ALTER TABLE conversation_sessions
  ADD COLUMN IF NOT EXISTS cleanup_retry_after timestamptz;

-- Rows already parked by the old behaviour become eligible on the next sweep.
UPDATE conversation_sessions
   SET cleanup_retry_after = now()
 WHERE cleanup_error_code IS NOT NULL AND cleanup_retry_after IS NULL;
