-- Bot API 10.0 delivers another bot's group messages once Bot-to-Bot Communication Mode is on.
-- Such a participant owns no application account, exactly like a channel-authored post, so it is
-- retained under its own verified Telegram identity instead of a manufactured human user.
ALTER TABLE telegram_group_messages
  DROP CONSTRAINT telegram_group_messages_actor_kind,
  ADD CONSTRAINT telegram_group_messages_actor_kind
    CHECK (actor_kind IN ('user', 'telegram_bot', 'telegram_channel', 'agent_self')),
  ADD CONSTRAINT telegram_group_messages_bot_actor_shape CHECK (
    actor_kind <> 'telegram_bot' OR (
      telegram_user_id ~ '^[1-9][0-9]*$'
      AND sender_is_bot = true
      AND actor_id = 'telegram-bot:' || telegram_user_id
    )
  );

-- A bot turn binds its memory sources like any other verified participant. Without this the first
-- bot-triggered turn fails at `turn.started` instead of reaching the model.
ALTER TABLE memory_turn_source_sets
  DROP CONSTRAINT memory_turn_source_sets_actor_kind,
  ADD CONSTRAINT memory_turn_source_sets_actor_kind CHECK (
    invoking_actor_kind IN ('telegram_user', 'telegram_bot', 'telegram_channel')
  );
