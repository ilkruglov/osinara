-- A series of one author's messages that called Mia (by a text or the caption of an album) keeps
-- that address on every member waiting in the queue: a member a failure or a restart returns there
-- comes back without the caption and must still be answered (26 November 2026). The mark is the
-- application's, so it lives beside Telegram's update and not inside it: inside the stored payload
-- it made a redelivery of the same update compare unequal, and the webhook answered 500 forever.
ALTER TABLE telegram_ingress_updates
  ADD COLUMN series_addressed boolean NOT NULL DEFAULT false;
