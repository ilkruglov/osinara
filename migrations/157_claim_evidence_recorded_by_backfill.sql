-- Who took down the evidence written before migration 155 (owner, 23 November 2026, after the
-- review of the fixes: the origin is in the memory operation log, not lost as first said). The
-- record's own create operation (`operation_key`; a later write of the same record logs another)
-- names the actor of its turn: the evidence's author is their own turn told to Mia; another person
-- took the words down from the chat; no actor in the session of a background review batch is the
-- silent review. No actor otherwise is a turn another bot started (it has no Telegram user id), or
-- unknown: unmarked, like evidence without an operation, it ranks as the person's words. Only the
-- primary evidence is marked: on production (23 November 2026) all evidence is primary, 9 037 by
-- the review, 12 in another person's turn, 453 in the author's own turn, 89 with no actor and no
-- batch (88 of them bots'), 44 without an operation.
--
-- The mark changes nothing a memory thread shows, so the trigger that drops the briefs of the
-- threads of every changed piece of evidence is off for this update.
DO $$
DECLARE
  turn_count integer;
  review_count integer;
  unmarked_count integer;
BEGIN
  -- The deferred check of a primary piece of evidence runs at the update itself: a pending trigger
  -- event would refuse turning the thread trigger back on.
  SET CONSTRAINTS claim_evidence_require_primary IMMEDIATE;
  ALTER TABLE claim_evidence DISABLE TRIGGER claim_evidence_invalidate_thread_projections;

  UPDATE claim_evidence AS evidence
     SET recorded_by = origin.recorded_by
    FROM (
      SELECT own.id,
             CASE
               WHEN operation.actor_telegram_user_id
                    = COALESCE(author_participant.telegram_user_id, author_user.telegram_user_id)
                 THEN 'turn'
               WHEN operation.actor_telegram_user_id IS NOT NULL OR EXISTS (
                 SELECT 1 FROM memory_review_batches AS batch
                 WHERE batch.eve_session_id = operation.eve_session_id
                   AND batch.batch_kind = 'background')
                 THEN 'review'
             END AS recorded_by
      FROM claim_evidence AS own
      JOIN memory_items_all AS item ON item.id = own.claim_id
      JOIN memory_mutation_operations AS operation
        ON operation.family_id = item.family_id AND operation.operation_key = item.operation_key
       AND operation.mutation_kind = 'create' AND operation.memory_item_id = item.id
      LEFT JOIN conversation_participants AS author_participant
        ON author_participant.id = own.author_participant_id
      LEFT JOIN users AS author_user ON author_user.id = own.author_user_id
      WHERE own.recorded_by IS NULL AND own.evidence_role = 'primary'
        AND operation.eve_session_id IS NOT NULL
    ) AS origin
   WHERE origin.id = evidence.id AND origin.recorded_by IS NOT NULL;

  ALTER TABLE claim_evidence ENABLE TRIGGER claim_evidence_invalidate_thread_projections;

  SELECT count(*) FILTER (WHERE recorded_by = 'turn'),
         count(*) FILTER (WHERE recorded_by = 'review'),
         count(*) FILTER (WHERE recorded_by IS NULL)
    INTO turn_count, review_count, unmarked_count
    FROM claim_evidence;
  RAISE NOTICE 'claim evidence origin: % told in the author''s turn, % taken down from the chat, % unmarked',
    turn_count, review_count, unmarked_count;
END $$;
