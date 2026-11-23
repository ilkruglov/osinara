-- Person cards no longer clean memory, and migration 153 returned what they hid: the cleanup journal
-- and the count of cleaned records per build are history.
DROP TABLE person_card_cleanups;
ALTER TABLE person_card_builds DROP COLUMN cleaned_records;
