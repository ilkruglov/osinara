-- Where a review lane's earlier context may begin. A batch shows the model up to 20 messages
-- before its own as already reviewed context; when the owner turns a group's review back on, the
-- lane restarts at the journal's end, and the messages from the time review was off are neither
-- reviewed nor shown (final review, 22 November 2026). Zero keeps every lane as it was.
ALTER TABLE memory_review_lanes
  ADD COLUMN context_floor_sequence bigint NOT NULL DEFAULT 0
    CHECK (context_floor_sequence >= 0);
