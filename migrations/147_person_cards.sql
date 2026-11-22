-- Person cards: a short summary of what Mia knows about one person in one memory area, rebuilt from
-- the person's records by a background model call. The owner's decision of 21 November 2026: instead
-- of a random pick of small records (4 625 preferences, 6.2 % ever used) Mia sees a card per person.
--
-- An area is where the card may be shown and which memory it may read: `personal` (area_key is the
-- user; their private chat), `family` (the family; the family group), `group` (one external group).
-- A card is never wider than its area; the subject is the person's Telegram user id.
CREATE TABLE person_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_ref text NOT NULL UNIQUE DEFAULT 'pcard_' || encode(gen_random_bytes(16), 'hex')
    CHECK (card_ref ~ '^pcard_[0-9a-f]{32}$'),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  area memory_scope NOT NULL,
  area_key uuid NOT NULL,
  subject_telegram_user_id text NOT NULL CHECK (char_length(subject_telegram_user_id) > 0),
  subject_label text NOT NULL CHECK (char_length(subject_label) BETWEEN 1 AND 200),
  version integer NOT NULL CHECK (version >= 1),
  sections jsonb NOT NULL,
  rendered_characters integer NOT NULL CHECK (rendered_characters > 0),
  -- The cited records; fewer of them still standing queues the card's daily rebuild, and the turn
  -- drops the items citing the gone ones.
  source_count integer NOT NULL CHECK (source_count >= 1),
  -- The snapshot the build read the records in; the person's own words written after it rebuild
  -- the card. Which records the card knows is `person_card_reads`, not this time.
  sources_as_of timestamptz NOT NULL,
  built_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, area, area_key, subject_telegram_user_id)
);

CREATE TABLE person_card_sources (
  card_id uuid NOT NULL REFERENCES person_cards(id) ON DELETE CASCADE,
  memory_item_id uuid NOT NULL REFERENCES memory_items_all(id) ON DELETE CASCADE,
  -- The version of the record the card read; an edit makes a new record and supersedes this one.
  source_updated_at timestamptz NOT NULL,
  -- How the record was tied to the person: its subject ids, the username of its «Имя (username)»
  -- label naming exactly one participant of the area, or a discussion the person took part in.
  link text NOT NULL CHECK (link IN ('subject', 'label', 'participation')),
  PRIMARY KEY (card_id, memory_item_id)
);
CREATE INDEX person_card_sources_item ON person_card_sources (memory_item_id);

-- Every record the build read: the profile block hides only these for a person shown by the card,
-- and only records outside this set count as new. A record that becomes visible after the build
-- (a projection switched on, a conflict resolved, a cleanup undone) is unread and shows up.
CREATE TABLE person_card_reads (
  card_id uuid NOT NULL REFERENCES person_cards(id) ON DELETE CASCADE,
  memory_item_id uuid NOT NULL REFERENCES memory_items_all(id) ON DELETE CASCADE,
  PRIMARY KEY (card_id, memory_item_id)
);
CREATE INDEX person_card_reads_item ON person_card_reads (memory_item_id);

-- A build request with its lease. A build whose lease ran out published nothing (publishing is one
-- transaction) and goes back to pending until its attempts run out.
CREATE TABLE person_card_builds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  area memory_scope NOT NULL,
  area_key uuid NOT NULL,
  subject_telegram_user_id text NOT NULL CHECK (char_length(subject_telegram_user_id) > 0),
  reason text NOT NULL CHECK (reason IN ('new_records', 'self_statement', 'invalidated')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- A model call with an unclear outcome (timeout, network, 5xx) returns the build here, later.
  retry_after timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  card_version integer,
  input_records integer,
  cited_records integer,
  cleaned_records integer NOT NULL DEFAULT 0 CHECK (cleaned_records >= 0),
  error_code text,
  -- An attempt may have cost a model call: any failure but a refusal before work, a lost lease.
  -- The weekly cap counts failed builds by it, not by the last attempt's code.
  possibly_paid boolean NOT NULL DEFAULT false,
  CHECK ((status = 'running') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status IN ('succeeded', 'failed')) = (finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX person_card_builds_one_open
  ON person_card_builds (family_id, area, area_key, subject_telegram_user_id)
  WHERE status IN ('pending', 'running');
CREATE INDEX person_card_builds_subject_requested
  ON person_card_builds (family_id, area, area_key, subject_telegram_user_id, requested_at DESC);
CREATE INDEX person_card_builds_open
  ON person_card_builds (status, requested_at) WHERE status IN ('pending', 'running');
-- The weekly cap counts a person's failed builds across all their areas.
CREATE INDEX person_card_builds_person_failed
  ON person_card_builds (family_id, subject_telegram_user_id, finished_at)
  WHERE status = 'failed' AND possibly_paid;

-- What a build marked as a repeat or as refuted by a newer record, with the model's reason. Undo
-- restores a record only while nobody changed it since (`cleaned_updated_at`) and while no record
-- stands in its slot (or says the same about the same person) that did not stand there when it
-- was cleaned (`slot_mate_ids`: active then, or cleaned by the same build).
CREATE TABLE person_card_cleanups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  build_id uuid NOT NULL REFERENCES person_card_builds(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  memory_item_id uuid NOT NULL REFERENCES memory_items_all(id) ON DELETE CASCADE,
  kept_memory_item_id uuid REFERENCES memory_items_all(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (reason IN ('duplicate', 'refuted')),
  explanation text NOT NULL CHECK (char_length(explanation) BETWEEN 1 AND 500),
  cleaned_updated_at timestamptz NOT NULL,
  slot_mate_ids uuid[] NOT NULL DEFAULT '{}',
  cleaned_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz,
  undo_outcome text CHECK (undo_outcome IN ('restored', 'changed_since')),
  CHECK ((undone_at IS NULL) = (undo_outcome IS NULL))
);
CREATE UNIQUE INDEX person_card_cleanups_open_item
  ON person_card_cleanups (memory_item_id) WHERE undone_at IS NULL;
CREATE INDEX person_card_cleanups_build ON person_card_cleanups (build_id);
-- The foreign keys' own actions: purging a memory record must not scan the whole journal.
CREATE INDEX person_card_cleanups_item ON person_card_cleanups (memory_item_id);
CREATE INDEX person_card_cleanups_kept ON person_card_cleanups (kept_memory_item_id)
  WHERE kept_memory_item_id IS NOT NULL;

-- A card Mia marked used in an answer (`<memory-used>` with the card ref): the metric of the cards.
-- The row outlives its card (a purged or undone card), so the metric keeps its history.
CREATE TABLE person_card_uses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  card_id uuid REFERENCES person_cards(id) ON DELETE SET NULL,
  card_ref text NOT NULL,
  card_version integer NOT NULL,
  application_session_id uuid NOT NULL,
  session_turn integer NOT NULL CHECK (session_turn >= 0),
  used_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (card_ref, application_session_id, session_turn)
);
CREATE INDEX person_card_uses_card ON person_card_uses (card_id) WHERE card_id IS NOT NULL;

-- A label «Имя (username)» is tied to a person by the participants holding that username in the
-- record's partition; every turn checks it for the cards it shows, the queue for all cards.
CREATE INDEX conversation_participants_partition_username
  ON conversation_participants (family_id, scope_partition_key, lower(username_snapshot))
  WHERE username_snapshot IS NOT NULL;
-- A card comes with the label-only records about the person it did not read: found by the label's
-- username (the expression of `labelUsernameSql`), not by reading the whole area.
CREATE INDEX memory_items_label_username
  ON memory_items_all (family_id, lower(substring(subject_label from '\(@?([A-Za-z0-9_]{4,})\)\s*$')))
  WHERE subject_user_id IS NULL AND subject_participant_id IS NULL;

-- The cards a turn's profile block carried, so shown and used turns are counted from the database.
ALTER TABLE profile_views ADD COLUMN person_card_ids uuid[] NOT NULL DEFAULT '{}';
