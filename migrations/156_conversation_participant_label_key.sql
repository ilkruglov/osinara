-- Person cards tie a record to a person by its whole «Имя (username)» label (Fable review, 23
-- November 2026). Computing the label of every participant for each record read the whole partition
-- (538 participants in one group): on production the card queue took 4.3 s a minute instead of
-- 255 ms, and every turn in that group paid the same per shown card (review of the fixes). The
-- participant's label is stored and indexed instead.
--
-- `person_label_key` is a label as records name people, lower-cased. With a username it is the label
-- the model sees (`participantLabel`: the name, with «(username)» appended unless the name already
-- ends in it), and «username (username)» when the name is empty or the username itself (228
-- records of 11 such people were tied to no one). Without a username it is the name. Spaces of any
-- kind off the edges, as JavaScript's `trim()` takes them. A record's label, and the name of a
-- participant without a username, lose the «@» of their closing «(@username)»: «Пётр
-- (@petya_p)» without a username holds Пётр's label, so it names no one. Review of the fixes,
-- owner 23 November 2026: the label is what the model sees, no more («Оля (@olya_o)» of olya_o is
-- «оля (@olya_o) (olya_o)»). `tiedLabelSql` (person-card-links.ts) is this function of the
-- record's label alone. Changing the function means recomputing the stored column in a new
-- migration.
CREATE FUNCTION person_label_trim(value text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN btrim(value, E' \u0009\u000a\u000b\u000c\u000d\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff');

-- A name without spaces at its edges and without the «@» of its closing «(@username)».
CREATE FUNCTION person_label_name(value text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN regexp_replace(person_label_trim(value), '\(@([A-Za-z0-9_]{4,})\)$', '(\1)');

-- A username without spaces at its edges and its leading «@»; NULL when nothing is left.
CREATE FUNCTION person_label_username(value text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN nullif(regexp_replace(person_label_trim(value), '^@', ''), '');

CREATE FUNCTION person_label_key(display_name text, username text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN lower(CASE
    WHEN person_label_username(username) IS NULL
      THEN nullif(person_label_name(display_name), '')
    WHEN nullif(person_label_trim(display_name), '') IS NULL
      OR lower(person_label_trim(display_name)) = lower(person_label_username(username))
      THEN person_label_username(username) || ' (' || person_label_username(username) || ')'
    WHEN right(lower(person_label_trim(display_name)), length(person_label_username(username)) + 2)
         = '(' || lower(person_label_username(username)) || ')'
      THEN person_label_trim(display_name)
    ELSE person_label_trim(display_name) || ' (' || person_label_username(username) || ')'
  END);

ALTER TABLE conversation_participants
  ADD COLUMN label_key text
  GENERATED ALWAYS AS (person_label_key(display_name_snapshot, username_snapshot)) STORED;

-- The one holder of a record's label in its partition: an index lookup per record.
CREATE INDEX conversation_participants_label_key
  ON conversation_participants (family_id, scope_partition_key, label_key)
  WHERE label_key IS NOT NULL;

-- The username index of migration 147 served the former tie by username; nothing reads it now.
DROP INDEX conversation_participants_partition_username;
