-- The deploy controller pauses new turns before it waits for the running ones: the poller stops,
-- but the webhook's own drain and the minute schedules could still start a turn after the wait saw
-- none, and stopping the release then cut it (Codex review, 6 November 2026). One row at most; the
-- controller sets it before the wait and clears it once the release stopped or the deploy was
-- cancelled, and a pause it left behind ends at its own deadline.
CREATE TABLE deploy_turn_pause (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  paused_until timestamptz NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now()
);
