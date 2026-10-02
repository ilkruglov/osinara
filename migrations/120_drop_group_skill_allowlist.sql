-- Custom group skills were removed in 083, which pinned skill_allowlist to an empty array behind a
-- CHECK. Nothing has read or written the column since; dropping it removes the constraint with it.
ALTER TABLE telegram_groups DROP COLUMN skill_allowlist;
