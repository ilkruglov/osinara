-- Person cards stop hiding memory (owner, 23 November 2026: «давай пока уберем чистку», «Вернуть
-- все», «Миграцией в этом релизе»). Every record a card build marked as a repeat or as refuted, by
-- an open row of its journal, comes back by the rules of the former undo command
-- (`person-card-cleanup-undo.ts`): only while it is as the cleanup left it (same version and
-- status, not deleted; a repeat only while its kept record stands) and while no active record took
-- its slot or its text about the same person that did not stand there when it was cleaned
-- (`slot_mate_ids`; records that stood together do not count). Newest first: of two hidden versions
-- of one slot the newer comes back. The deploy runs migrations with the services stopped, so
-- nothing writes memory meanwhile.
--
-- A repeat the cards hid that cannot come back, by an open or a closed journal row, is deleted
-- (soft, recoverable for the retention window; review of the fixes, owner 23 November 2026): it is
-- the fact of its kept record, and standing superseded behind another record it would come back
-- when that record is deleted and purged (`clear_memory_lifecycle_references`), as deleting a
-- record used to take its repeats along against. An older version of a slot that stood behind such
-- a repeat moves behind the active version of that slot, or else behind the repeat's kept record
-- (5 on production, 23 November 2026). No card-written `duplicate` remains, so deleting a
-- record has no repeats to take any more. Repeats outside the journal (consolidation before
-- v0.12.0; none on production) are left as they are. A refuted record that cannot come back stays
-- superseded, as slot versions always were.
--
-- The build that cleaned a record read it: that read hid it from the profile block. Reads of the
-- records of open rows go, except a read by a card that cites the record (it came back when its
-- successor was purged and a later build put it in an item). The log names why records stayed.
DO $$
DECLARE
  cleanup record;
  hidden record;
  cleaned_status memory_claim_status;
  restored integer := 0;
  already_back integer := 0;
  changed_since integer := 0;
  deleted integer := 0;
  kept_gone integer := 0;
  slot_taken integer := 0;
  repeats_deleted integer := 0;
  moved_behind integer := 0;
  moved integer;
  slot_version uuid;
  reads_dropped integer := 0;
BEGIN
  FOR cleanup IN
    SELECT journal.*
    FROM person_card_cleanups AS journal
    JOIN memory_items_all AS item ON item.id = journal.memory_item_id
    WHERE journal.undone_at IS NULL
    ORDER BY item.created_at DESC, item.id DESC
  LOOP
    SELECT * INTO hidden FROM memory_items_all WHERE id = cleanup.memory_item_id;
    cleaned_status := CASE cleanup.reason WHEN 'duplicate' THEN 'duplicate'
                                          ELSE 'superseded' END;
    IF hidden.deleted_at IS NOT NULL THEN
      deleted := deleted + 1;
    ELSIF hidden.claim_status = 'active' THEN
      -- A refuted record back when its successor was purged: visible already.
      already_back := already_back + 1;
    ELSIF hidden.updated_at <> cleanup.cleaned_updated_at
       OR hidden.claim_status <> cleaned_status THEN
      changed_since := changed_since + 1;
    ELSIF cleanup.reason = 'duplicate' AND NOT EXISTS (
      SELECT 1 FROM memory_items AS kept WHERE kept.id = cleanup.kept_memory_item_id
    ) THEN
      kept_gone := kept_gone + 1;
    ELSIF EXISTS (
      SELECT 1 FROM memory_items AS other
      WHERE other.family_id = hidden.family_id AND other.scope = hidden.scope
        AND other.scope_partition_key = hidden.scope_partition_key AND other.id <> hidden.id
        AND other.subject_user_id IS NOT DISTINCT FROM hidden.subject_user_id
        AND other.subject_participant_id IS NOT DISTINCT FROM hidden.subject_participant_id
        AND other.subject_label IS NOT DISTINCT FROM hidden.subject_label
        AND ((hidden.attribute IS NOT NULL AND other.attribute = hidden.attribute
              AND other.memory_project_id IS NOT DISTINCT FROM hidden.memory_project_id
              AND (other.kind = 'episode') = (hidden.kind = 'episode'))
          OR other.content_normalized = hidden.content_normalized)
        AND other.claim_status = 'active' AND other.id <> ALL(cleanup.slot_mate_ids)
        AND NOT EXISTS (SELECT 1 FROM person_card_cleanups AS theirs
                        WHERE theirs.memory_item_id = other.id
                          AND hidden.id = ANY(theirs.slot_mate_ids))
    ) THEN
      slot_taken := slot_taken + 1;
    ELSE
      UPDATE memory_items_all
         SET claim_status = 'active', duplicate_of = NULL, superseded_by = NULL, updated_at = now()
       WHERE id = hidden.id;
      INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
      VALUES (cleanup.family_id, NULL, 'memory.person_card_cleanup_undone', hidden.id,
              jsonb_build_object('cleanupId', cleanup.id::text, 'reason', cleanup.reason,
                                 'by', 'migration 153'));
      restored := restored + 1;
    END IF;
  END LOOP;

  FOR hidden IN
    SELECT item.* FROM memory_items_all AS item
    WHERE item.claim_status = 'duplicate' AND item.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM person_card_cleanups AS journal
                  WHERE journal.memory_item_id = item.id)
  LOOP
    -- An older version of the slot that stood behind the repeat stands behind the active version of
    -- that slot, or else behind the repeat's kept record, the same fact: behind the deleted repeat
    -- it would come back when that is purged. Not the kept record first: it may be another slot's,
    -- and its deletion would bring the old version back beside the slot's current one (review).
    slot_version := NULL;
    IF hidden.attribute IS NOT NULL THEN
      SELECT other.id INTO slot_version
      FROM memory_items AS other
      WHERE other.family_id = hidden.family_id AND other.scope = hidden.scope
        AND other.scope_partition_key = hidden.scope_partition_key AND other.id <> hidden.id
        AND other.subject_user_id IS NOT DISTINCT FROM hidden.subject_user_id
        AND other.subject_participant_id IS NOT DISTINCT FROM hidden.subject_participant_id
        AND other.subject_label IS NOT DISTINCT FROM hidden.subject_label
        AND other.attribute = hidden.attribute
        AND other.memory_project_id IS NOT DISTINCT FROM hidden.memory_project_id
        AND (other.kind = 'episode') = (hidden.kind = 'episode')
        AND other.claim_status = 'active'
      ORDER BY other.created_at DESC, other.id DESC
      LIMIT 1;
    END IF;
    UPDATE memory_items_all SET superseded_by = COALESCE(slot_version, hidden.duplicate_of)
     WHERE superseded_by = hidden.id;
    GET DIAGNOSTICS moved = ROW_COUNT;
    moved_behind := moved_behind + moved;
    UPDATE memory_items_all
       SET deleted_at = now(), claim_status = 'retracted', superseded_by = NULL,
           duplicate_of = NULL
     WHERE id = hidden.id;
    DELETE FROM memory_embedding_jobs WHERE memory_item_id = hidden.id;
    INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
    VALUES (hidden.family_id, NULL, 'memory.deleted', hidden.id,
            jsonb_build_object('scope', hidden.scope::text, 'kind', hidden.kind::text,
                               'reason', 'person_card_repeat',
                               'repeatOf', hidden.duplicate_of::text, 'by', 'migration 153'));
    repeats_deleted := repeats_deleted + 1;
  END LOOP;

  DELETE FROM person_card_reads AS card_read
  USING person_card_cleanups AS journal
  WHERE journal.memory_item_id = card_read.memory_item_id AND journal.undone_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM person_card_sources AS cited
      WHERE cited.card_id = card_read.card_id AND cited.memory_item_id = card_read.memory_item_id
    );
  GET DIAGNOSTICS reads_dropped = ROW_COUNT;

  RAISE NOTICE 'person card cleanup returned: % restored, % already back; stayed hidden: % changed since, % deleted, % kept record gone, % slot taken; % repeats left hidden deleted, % older versions moved behind the active version of their slot or the kept record; % reads dropped',
    restored, already_back, changed_since, deleted, kept_gone, slot_taken, repeats_deleted,
    moved_behind, reads_dropped;
END $$;
