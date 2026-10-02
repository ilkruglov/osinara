-- Supergroup members carry tags («Батя», «Token Burner») that Telegram sends per message in
-- `sender_tag`. A tag is chosen by the group, changes over time and is not unique, so it is kept
-- with each message for the timeline Mia reads and never used as an identity.
ALTER TABLE telegram_group_messages
  ADD COLUMN sender_tag text CHECK (sender_tag IS NULL OR char_length(sender_tag) BETWEEN 1 AND 64);
