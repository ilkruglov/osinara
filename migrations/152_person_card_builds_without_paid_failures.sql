-- One build of a card a day at most, a failed one included, bounds what a failing card costs; the
-- weekly count of possibly paid failures is gone with its column (owner, 23 November 2026).
-- A build the previous release queued and never ran (the person's own words rebuilt at once) would
-- be claimed without the daily rule: it goes, and the queue asks again by the new rules. A build
-- back in the queue after an unclear model outcome has paid attempts: it stays and keeps counting
-- them (review of the fixes), as does a running one.
DELETE FROM person_card_builds WHERE status = 'pending' AND attempts = 0;
ALTER TABLE person_card_builds DROP COLUMN possibly_paid;
