-- Утренний пост канала «Остриков пилит агентов» (23 октября 2026, 9:21 МСК, message_id 96491
-- в группе обсуждения «Дизраптим») пришёл как rich-сообщение и был отброшен ingress'ом 1.8.43
-- как «медиа во внешней группе»: в журнале группы его нет, Мия его не видит. Telegram не даёт
-- перечитать сообщение, но кладёт его целиком в reply_to_message ответа на него (апдейт
-- 85122277). Отсюда пост подшивается в журнал так, как его записал бы ingress 1.8.45: автор
-- канал, вид photo, текст из блоков, крупнейший размер фото как вложение. На базе без этого
-- апдейта или с уже записанным постом миграция ничего не делает. Ответы на пост не
-- перепривязываются: их цитата уже берётся из самого ответа.
CREATE FUNCTION pg_temp.osinara_rich_text(value jsonb) RETURNS text LANGUAGE plpgsql AS $$
DECLARE part jsonb; acc text := '';
BEGIN
  IF value IS NULL THEN RETURN ''; END IF;
  CASE jsonb_typeof(value)
    WHEN 'string' THEN RETURN value #>> '{}';
    WHEN 'array' THEN
      FOR part IN SELECT * FROM jsonb_array_elements(value) LOOP
        acc := acc || pg_temp.osinara_rich_text(part);
      END LOOP;
      RETURN acc;
    WHEN 'object' THEN RETURN pg_temp.osinara_rich_text(value->'text');
    ELSE RETURN '';
  END CASE;
END $$;

CREATE FUNCTION pg_temp.osinara_rich_blocks_text(blocks jsonb) RETURNS text[] LANGUAGE plpgsql AS $$
DECLARE block jsonb; item jsonb; parts text[] := '{}'; text_part text;
BEGIN
  IF blocks IS NULL OR jsonb_typeof(blocks) <> 'array' THEN RETURN parts; END IF;
  FOR block IN SELECT * FROM jsonb_array_elements(blocks) LOOP
    CASE block->>'type'
      WHEN 'paragraph', 'section_heading', 'preformatted', 'footer', 'thinking', 'mathematical_expression' THEN
        parts := parts || pg_temp.osinara_rich_text(block->'text');
      WHEN 'details' THEN
        parts := parts || pg_temp.osinara_rich_text(coalesce(block->'summary', block->'header'))
          || pg_temp.osinara_rich_blocks_text(block->'blocks');
      WHEN 'blockquote', 'expandable_blockquote', 'block_quotation', 'expandable_block_quotation' THEN
        parts := parts || pg_temp.osinara_rich_blocks_text(block->'blocks');
      WHEN 'pull_quotation' THEN
        parts := parts || pg_temp.osinara_rich_text(block->'text') || pg_temp.osinara_rich_blocks_text(block->'blocks');
      WHEN 'list' THEN
        FOR item IN SELECT * FROM jsonb_array_elements(coalesce(block->'items', '[]'::jsonb)) LOOP
          text_part := pg_temp.osinara_rich_text(item->'text');
          IF text_part <> '' THEN parts := parts || text_part;
          ELSE parts := parts || pg_temp.osinara_rich_blocks_text(item->'blocks'); END IF;
        END LOOP;
      WHEN 'animation', 'audio', 'photo', 'video', 'voice_note', 'document' THEN
        parts := parts || pg_temp.osinara_rich_text(coalesce(block->'caption'->'text', block->'caption'));
      ELSE NULL;
    END CASE;
  END LOOP;
  RETURN parts;
END $$;

DO $$
DECLARE
  post jsonb;
  conversation uuid;
  "group" uuid;
  largest jsonb;
  content text;
  sequence bigint;
  entry uuid;
BEGIN
  SELECT payload->'message'->'reply_to_message' INTO post
  FROM telegram_ingress_updates WHERE update_id = 85122277;
  IF post IS NULL OR (post->>'message_id') <> '96491' OR post->'rich_message'->'blocks' IS NULL THEN RETURN; END IF;

  SELECT alias.conversation_id, alias.group_id INTO conversation, "group"
  FROM telegram_group_message_ids alias
  JOIN telegram_groups g ON g.id = alias.group_id
  WHERE g.telegram_chat_id = post->'chat'->>'id' AND alias.telegram_message_id = 97025;
  IF conversation IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM telegram_group_message_ids WHERE group_id = "group" AND telegram_message_id = 96491) THEN RETURN; END IF;

  SELECT string_agg(part, E'\n\n') INTO content
  FROM unnest(pg_temp.osinara_rich_blocks_text(post->'rich_message'->'blocks')) AS part
  WHERE btrim(part) <> '';
  IF content IS NULL OR content = '' THEN RETURN; END IF;

  SELECT size INTO largest
  FROM jsonb_array_elements(post->'rich_message'->'blocks') AS block,
       jsonb_array_elements(block->'photo') AS size
  WHERE block->>'type' = 'photo'
  ORDER BY coalesce((size->>'width')::int, 0) * coalesce((size->>'height')::int, 0) DESC
  LIMIT 1;

  UPDATE application_conversations
  SET next_timeline_sequence = greatest(next_timeline_sequence, coalesce((
      SELECT max(sequence_id) FROM telegram_group_messages WHERE conversation_id = conversation
    ), 0)) + 1, updated_at = now()
  WHERE id = conversation RETURNING next_timeline_sequence INTO sequence;

  INSERT INTO telegram_group_messages
    (conversation_id, group_id, sequence_id, actor_kind, actor_id, telegram_message_id,
     telegram_user_id, sender_username, sender_display_name, sender_is_bot, message_kind,
     content_text, sent_at, telegram_sender_chat_id,
     attachment_kind, attachment_file_id, attachment_file_unique_id, attachment_file_name,
     attachment_media_type, attachment_size, attachment_source_message_id)
  VALUES
    (conversation, "group", sequence, 'telegram_channel', 'telegram-channel:' || (post->'sender_chat'->>'id'), 96491,
     NULL, post->'sender_chat'->>'username', post->'sender_chat'->>'title', false,
     CASE WHEN largest IS NULL THEN 'text' ELSE 'photo' END,
     content, to_timestamp((post->>'date')::bigint), post->'sender_chat'->>'id',
     CASE WHEN largest IS NULL THEN NULL ELSE 'photo' END, largest->>'file_id', largest->>'file_unique_id',
     CASE WHEN largest IS NULL THEN NULL ELSE 'photo.jpg' END,
     CASE WHEN largest IS NULL THEN NULL ELSE 'image/jpeg' END, (largest->>'file_size')::bigint,
     CASE WHEN largest IS NULL THEN NULL ELSE 96491 END)
  RETURNING id INTO entry;

  INSERT INTO telegram_group_message_ids (conversation_id, group_id, telegram_message_id, entry_id)
  VALUES (conversation, "group", 96491, entry);
END $$;

DROP FUNCTION pg_temp.osinara_rich_blocks_text(jsonb);
DROP FUNCTION pg_temp.osinara_rich_text(jsonb);
