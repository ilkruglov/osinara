-- A whisper (`/whisper`, Telegram ephemeral command) gets its own application session next to the
-- group's: the database admits one active canonical session per group topic and per sandbox thread,
-- so a whisper session is a kind of its own. Like other non-canonical sessions it ends with its turn
-- and shares the group's sandbox thread.
ALTER TYPE conversation_session_kind ADD VALUE IF NOT EXISTS 'whisper';
