-- Removing a group or changing its type deletes its journal by cascade. Three references to the
-- journal had no delete action: the sources of a silent review batch and of a turn's memory
-- binding. While a batch was open (for good when review was switched off with a batch left at the
-- cursor) or a turn ran, the owner got a raw foreign-key error and the group stayed (repeat review,
-- 23 November 2026). The sources mean nothing without their message, so they go with it.
ALTER TABLE memory_review_batch_sources
  DROP CONSTRAINT memory_review_batch_sources_timeline_entry_id_conversation_fkey,
  ADD CONSTRAINT memory_review_batch_sources_timeline_entry_id_conversation_fkey
    FOREIGN KEY (timeline_entry_id, conversation_id)
    REFERENCES telegram_group_messages(id, conversation_id) ON DELETE CASCADE;

ALTER TABLE memory_turn_source_sets
  DROP CONSTRAINT memory_turn_source_sets_current_timeline_entry_id_conversa_fkey,
  ADD CONSTRAINT memory_turn_source_sets_current_timeline_entry_id_conversa_fkey
    FOREIGN KEY (current_timeline_entry_id, conversation_id)
    REFERENCES telegram_group_messages(id, conversation_id) ON DELETE CASCADE;

ALTER TABLE memory_turn_sources
  DROP CONSTRAINT memory_turn_sources_timeline_entry_id_conversation_id_fkey,
  ADD CONSTRAINT memory_turn_sources_timeline_entry_id_conversation_id_fkey
    FOREIGN KEY (timeline_entry_id, conversation_id)
    REFERENCES telegram_group_messages(id, conversation_id) ON DELETE CASCADE;
