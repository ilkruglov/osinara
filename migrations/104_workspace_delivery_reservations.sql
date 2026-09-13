-- Include in-flight sends in the recipient/turn/content lookup. Existing receipts stay intact;
-- reservation concurrency is serialized by the repository's transaction advisory lock.
CREATE INDEX workspace_file_deliveries_reserved_content_idx
  ON workspace_file_deliveries
    (telegram_chat_id, turn_id, content_sha256, telegram_message_thread_id)
  WHERE status IN ('started', 'completed');
