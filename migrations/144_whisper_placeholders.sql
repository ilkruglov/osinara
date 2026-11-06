-- The placeholder of each whisper (`/whisper`), recorded when the webhook sends it. What the
-- placeholder shows is kept here rather than in the process: a restart, a failed edit or a turn that
-- ended without telling its author would otherwise leave «Думаю…» there for good, or let a failure
-- notice overwrite an answer already shown (Codex review, 6 November 2026).
--
-- status is what the placeholder shows or is about to show:
--   open      the placeholder text, nothing else yet;
--   progress  text the model wrote before a tool call;
--   answered  the answer, its emoji, or nothing (silence removes the placeholder);
--   failed    a failure or «no answer» text; a late answer may still replace it;
--   closed    removed by the application (a redelivered or never queued whisper).
-- pending_content is the edit not yet confirmed by Telegram: {"format","text"} or {"remove":true}.
-- It is written before the call, so a crash or a refused attempt leaves it for the minute sweep.
CREATE TABLE telegram_whisper_placeholders (
  telegram_chat_id text NOT NULL CHECK (telegram_chat_id ~ '^-?[0-9]+$'),
  placeholder_message_id bigint NOT NULL CHECK (placeholder_message_id > 0),
  receiver_user_id text NOT NULL CHECK (receiver_user_id ~ '^[1-9][0-9]*$'),
  update_id bigint NOT NULL CHECK (update_id >= 0),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'progress', 'answered', 'failed', 'closed')),
  pending_content jsonb CHECK (pending_content IS NULL OR jsonb_typeof(pending_content) = 'object'),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (telegram_chat_id, placeholder_message_id),
  CHECK ((pending_content IS NULL) = (next_attempt_at IS NULL))
);

CREATE INDEX telegram_whisper_placeholders_due
  ON telegram_whisper_placeholders (next_attempt_at)
  WHERE pending_content IS NOT NULL;

CREATE INDEX telegram_whisper_placeholders_open
  ON telegram_whisper_placeholders (created_at)
  WHERE status = 'open';

CREATE INDEX telegram_whisper_placeholders_updated
  ON telegram_whisper_placeholders (updated_at);
