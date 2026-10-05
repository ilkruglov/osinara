-- A group journal keeps the last 10 000 messages; writing a new one deletes the oldest in the
-- same transaction. The foreign key of claim_evidence then nulls timeline_entry_id, which is an
-- UPDATE of the evidence row, and the identity trigger re-ran both its checks on every UPDATE:
-- the nulling failed once the claim was soft-deleted (the memory_items view no longer shows it)
-- or the author participant was linked to a user later, and the rollback took the new message
-- with it, so the group stopped accepting messages at all (upstream nyxandro/osinara #306, their
-- migration 119). On 5 October 2026 two production groups sat at the cap, one with three sources
-- of deleted records 2 500 messages from it.
--
-- Both checks guard what the evidence is attached to: which claim and which author. They run
-- when those columns are written, not when an unrelated one such as the source link changes.
-- Attaching evidence to deleted memory is still refused.
CREATE OR REPLACE FUNCTION validate_claim_evidence_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_user uuid;
  claim_provenance memory_provenance_state;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.claim_id IS DISTINCT FROM OLD.claim_id THEN
    SELECT provenance_state INTO claim_provenance FROM memory_items WHERE id = NEW.claim_id;
    IF claim_provenance IS DISTINCT FROM 'evidenced'::memory_provenance_state THEN
      RAISE EXCEPTION 'AGENT_CLAIM_EVIDENCE_PROVENANCE_INVALID: claim must be evidenced';
    END IF;
  END IF;

  IF NEW.author_participant_id IS NOT NULL AND (
    TG_OP = 'INSERT'
    OR NEW.author_participant_id IS DISTINCT FROM OLD.author_participant_id
    OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
  ) THEN
    SELECT linked_user_id INTO linked_user
    FROM conversation_participants
    WHERE id = NEW.author_participant_id;
    IF NEW.author_user_id IS DISTINCT FROM linked_user THEN
      RAISE EXCEPTION 'AGENT_CLAIM_EVIDENCE_AUTHOR_LINK_INVALID: author user link is not exact';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
