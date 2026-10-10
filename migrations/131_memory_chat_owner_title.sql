-- On 10 September 2026 the silent review turned Ilya Kruglov's «я её владелец» (he owns Mia, the
-- bot) into «владелец чата» in Ft86, and from 18 September put that title in front of facts about
-- other people («По словам владельца чата Ильи Круглова …»). Nobody there calls him the chat's
-- owner; on 10 October Mia repeated the title from memory and two participants corrected her.
-- The title goes only where it stands right before his name (another person's real title stays,
-- Codex review), in the text and its normalized form (which
-- lowercases, hence the second pattern); the slot «оценка владельца чата» becomes «оценка Ильи
-- Круглова»; a visible edited record is reindexed. A record that only quotes someone talking about
-- a chat owner keeps its words. Matching only what is left to fix makes a second run a no-op.
WITH fixed AS (
  UPDATE memory_items_all AS item
     SET content = regexp_replace(item.content, '[Вв]ладел(ец|ьца|ьцу|ьцем|ьце) чата (?=(Иль[а-яё]* Кругл|Ilya Kruglov))', '', 'g'),
         content_normalized = regexp_replace(item.content_normalized, 'владел(ец|ьца|ьцу|ьцем|ьце) чата (?=(иль[а-яё]* кругл|ilya kruglov))', '', 'g'),
         attribute = CASE WHEN item.attribute = 'оценка владельца чата' THEN 'оценка Ильи Круглова' ELSE item.attribute END,
         embedding_status = CASE WHEN item.deleted_at IS NULL THEN 'pending' ELSE item.embedding_status END,
         updated_at = now()
   WHERE item.content ~ '[Вв]ладел(ец|ьца|ьцу|ьцем|ьце) чата (Иль[а-яё]* Кругл|Ilya Kruglov)'
   RETURNING item.id, item.created_at, item.deleted_at
)
INSERT INTO memory_embedding_jobs (memory_item_id, created_at)
SELECT id, created_at FROM fixed WHERE deleted_at IS NULL
ON CONFLICT (memory_item_id) DO UPDATE
   SET status = 'pending', attempts = 0, lease_token = NULL, lease_expires_at = NULL,
       last_error_code = NULL, updated_at = now();
