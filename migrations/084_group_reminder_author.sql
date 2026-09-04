-- Group-scoped proactive delivery is chat-level by contract, so the group shape forbids a thread
-- exactly like `agent_schedules` and `proactive_deliveries` do: a stored topic would deliver into a
-- forum topic and then fail completion after Telegram already accepted the message.
-- A reminder created inside an external Telegram group has no account behind its author, so the
-- durable author identity is the verified Telegram user id. The account column stays required for
-- the two trusted scopes, which keeps membership-based authorization unchanged for them.
ALTER TABLE reminders
  ALTER COLUMN author_user_id DROP NOT NULL;

ALTER TABLE reminders
  ADD COLUMN author_telegram_user_id text
    CHECK (char_length(author_telegram_user_id) BETWEEN 1 AND 32);

-- The shape constraint was created unnamed and the table was later renamed, so its generated name
-- is not stable across environments. It is located by definition and a miss aborts the migration
-- instead of silently leaving the old two-scope shape in force.
DO $$
DECLARE
  shape_constraint text;
BEGIN
  SELECT conname INTO shape_constraint
  FROM pg_constraint
  WHERE conrelid = 'reminders'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%owner_user_id IS NOT NULL%';
  IF shape_constraint IS NULL THEN
    RAISE EXCEPTION 'AGENT_MIGRATION_REMINDER_SHAPE_CONSTRAINT_MISSING';
  END IF;
  EXECUTE format('ALTER TABLE reminders DROP CONSTRAINT %I', shape_constraint);
END $$;

ALTER TABLE reminders
  ADD CONSTRAINT reminders_scope_shape CHECK (
    (scope = 'personal' AND owner_user_id IS NOT NULL AND author_user_id IS NOT NULL
      AND author_telegram_user_id IS NULL AND group_id IS NULL AND message_thread_id IS NULL) OR
    (scope = 'family' AND owner_user_id IS NULL AND author_user_id IS NOT NULL
      AND author_telegram_user_id IS NULL AND group_id IS NOT NULL) OR
    (scope = 'group' AND owner_user_id IS NULL AND author_user_id IS NULL
      AND author_telegram_user_id IS NOT NULL AND group_id IS NOT NULL
      AND message_thread_id IS NULL AND forum_topic_id IS NULL)
  );

-- The chat cap is counted over live reminders only: a delivered one-shot reminder frees its slot,
-- while an active, paused or in-flight one still occupies it. The author column stays in the index
-- as stored provenance; the count itself is served by the leading group column.
CREATE INDEX reminders_group_live_idx
  ON reminders (group_id, author_telegram_user_id)
  WHERE scope = 'group' AND status IN ('active', 'leased', 'paused');
