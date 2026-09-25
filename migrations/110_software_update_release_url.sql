-- Releases moved from nyxandro/osinara to ilkruglov/osinara on 17 сентября 2026. The release
-- client, the manifest image prefixes and the host deploy controller all moved; this check did not,
-- so every six-hourly update check found v1.2.x, failed the INSERT and proposed nothing.
--
-- Rows written before the move keep their upstream URL and must stay updatable: a new proposal
-- supersedes every open older one in the same transaction, and PostgreSQL re-checks CHECK
-- constraints on UPDATE. So the upstream prefix stays valid only for rows created before the move.
-- The installed 1.1.0 cannot receive this migration through an update proposal it cannot create,
-- so production gets the same DDL by hand once; IF EXISTS keeps this file safe to run afterwards.
ALTER TABLE software_update_proposals
  DROP CONSTRAINT IF EXISTS software_update_proposals_release_url_check;

ALTER TABLE software_update_proposals
  ADD CONSTRAINT software_update_proposals_release_url_check CHECK (
    release_url LIKE 'https://github.com/ilkruglov/osinara/releases/tag/v%'
    OR (
      release_url LIKE 'https://github.com/nyxandro/osinara/releases/tag/v%'
      AND created_at < '2026-09-18T00:00:00Z'::timestamptz
    )
  );
