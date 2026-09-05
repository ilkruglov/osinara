-- Skill names are validated against the installed filesystem catalog by the application.
-- PostgreSQL protects array shape without hard-coding a second, divergent list of installed skills.
CREATE FUNCTION valid_group_skill_names(names text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT count(*) <= 128 AND count(*) = count(DISTINCT name)
    AND count(*) = count(*) FILTER (WHERE name ~ '^[a-z0-9][a-z0-9-]*$')
  FROM unnest(names) AS name
$$;

ALTER TABLE telegram_groups DROP CONSTRAINT telegram_groups_skill_allowlist_safe;
ALTER TABLE telegram_groups ADD CONSTRAINT telegram_groups_skill_allowlist_safe
  CHECK (valid_group_skill_names(skill_allowlist));

-- Page reading is baseline for every external group; it is no longer an owner-managed toggle.
UPDATE telegram_groups SET tool_allowlist = array_remove(tool_allowlist, 'web_fetch')
WHERE tool_allowlist @> ARRAY['web_fetch']::text[];
