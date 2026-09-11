-- The same bytes reached one chat twice in one turn on 11 сентября 2026: the model sent the file
-- once as a photo and five seconds later as a document, two distinct tool call ids for one content
-- hash. Exactly-once is keyed on the call id, so both passed the guard. The turn is the natural
-- scope for "already sent": a repeat inside one turn is always a mistake, while a later request to
-- send the same file again is a legitimate thing to ask for.
ALTER TABLE workspace_file_deliveries
  ADD COLUMN IF NOT EXISTS turn_id text;

CREATE INDEX IF NOT EXISTS workspace_file_deliveries_turn_content_idx
  ON workspace_file_deliveries (telegram_chat_id, turn_id, content_sha256)
  WHERE status = 'completed';
