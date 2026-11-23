-- The chat journal keeps every entry since 22 November 2026 (the owner removed the cap of 10 000 a
-- chat). Deleting or retyping a group cascades its entries, and for each one PostgreSQL looks up the
-- rows that point at it to set them NULL. These three references had no index, so every deleted
-- entry scanned the whole table: 10 000 entries in a table of 425 000 took 552 s, 0.54 s indexed.
CREATE INDEX IF NOT EXISTS telegram_group_messages_reply_to_entry
  ON telegram_group_messages (reply_to_entry_id)
  WHERE reply_to_entry_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS behavior_preferences_last_source_timeline_entry
  ON behavior_preferences (last_source_timeline_entry_id)
  WHERE last_source_timeline_entry_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS turn_evaluations_triggering_entry
  ON turn_evaluations (triggering_entry_id)
  WHERE triggering_entry_id IS NOT NULL;

