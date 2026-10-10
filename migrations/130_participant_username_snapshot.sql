-- A participant's Telegram username next to its display name (10 October 2026). Both are display
-- snapshots, never identity: the profile card and the timeline label a person «Имя (username)»,
-- because in Ft86 «Ilya» (Ilya_Demchenko) and «Ilya Kruglov» (ilya_kruglov) are both «Илья» to the
-- chat, and the prompt's rule to tell namesakes apart by username had no username to read. Filled
-- from each participant's latest timeline message.
ALTER TABLE conversation_participants
  ADD COLUMN username_snapshot text CHECK (char_length(username_snapshot) BETWEEN 1 AND 64);

UPDATE conversation_participants AS participant
   SET username_snapshot = latest.sender_username
  FROM (
    SELECT DISTINCT ON (message.conversation_id, message.telegram_user_id)
           message.conversation_id, message.telegram_user_id, message.sender_username
      FROM telegram_group_messages AS message
     WHERE message.telegram_user_id IS NOT NULL AND message.conversation_id IS NOT NULL
     ORDER BY message.conversation_id, message.telegram_user_id, message.sequence_id DESC
  ) AS latest
 WHERE latest.conversation_id = participant.conversation_id
   AND latest.telegram_user_id = participant.telegram_user_id
   AND char_length(latest.sender_username) BETWEEN 1 AND 64;
