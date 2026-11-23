-- Who took a piece of evidence down: Mia in the turn the person wrote in ('turn'), or the silent
-- review of the chat afterwards ('review'). A card ranks the person's own words told in their turn
-- above the review's reading of them (owner, 23 November 2026). Evidence written before is unknown
-- (NULL) and ranks as the person's words, as it did.
ALTER TABLE claim_evidence
  ADD COLUMN recorded_by text CHECK (recorded_by IN ('turn', 'review'));
