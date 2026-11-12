-- Where a person's health journal lives. `database` is the journal kept by the journal tools.
-- `files` is a journal the person keeps in their personal workspace (`health/`): there the journal
-- tools refuse and Mia keeps the files. Nothing is deleted or moved: records already in the database
-- stay as they are, unused while the mode is `files`.
ALTER TABLE health_profiles
  ADD COLUMN journal_mode text NOT NULL DEFAULT 'database'
    CHECK (journal_mode IN ('database', 'files'));

-- The owner's decision of 11 November 2026 for one person who keeps the journal in files. On any
-- other installation the user does not exist and nothing is written. A person belongs to one family
-- (`one_family_per_user`), so the family of a new profile row is unambiguous; an existing row keeps
-- everything but the mode.
INSERT INTO health_profiles (owner_user_id, family_id, journal_mode)
SELECT membership.user_id, membership.family_id, 'files'
  FROM family_memberships AS membership
 WHERE membership.user_id = '3f08f970-47d1-4268-869a-d7572c6d7ce4'
ON CONFLICT (owner_user_id) DO UPDATE SET journal_mode = 'files', updated_at = now();
