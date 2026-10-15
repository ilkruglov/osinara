-- В Ft86 два Ильи: Ilya (Ilya_Demchenko), «логист» чата и герой его главного мема, и владелец
-- Ilya Kruglov (ilya_kruglov). Девять записей памяти группы, в основном от 10 сентября 2026 (до
-- того, как тихая проверка стала писать username рядом с именем), называют первого «Илья-логист»
-- без username; остальные четыре десятка упоминаний «логиста» это мем чата, а не человек.
-- 15 октября в 23:43 UTC владелец написал Мие «ты тупая железка», и в отповеди она приняла его за
-- логиста («выясняет у логиста, тупая ли она»), следующим ходом сама объяснив, что перепутала
-- двух Ильёй. Первое упоминание «Илья-логист» в любом падеже в записи без username получает
-- «(Ilya_Demchenko)», в тексте и в нормализованной форме (нижний регистр, пунктуация заменена
-- пробелами, поэтому «илья логист» и «ilya demchenko»); видимая правленая запись
-- переиндексируется. Только эта группа; записи, где этот username уже есть (целым словом: похожий
-- чужой username не считается), не трогаются, поэтому повторный запуск ничего не меняет. Запись,
-- где в нормализованной форме упоминаний «иль… логист» больше, чем «Иль…-логист» в тексте
-- («Илья, логист …» даёт то же «илья логист»), пропускается: иначе username встал бы в
-- нормализованной форме не там, где в тексте, и точное сопоставление записей разошлось бы.
WITH fixed AS (
  UPDATE memory_items_all AS item
     SET content = regexp_replace(item.content, '(Иль[а-яё]+-логист[а-яё]*)', '\1 (Ilya_Demchenko)'),
         content_normalized = regexp_replace(item.content_normalized, '(иль[а-яё]+ логист[а-яё]*)', '\1 ilya demchenko'),
         embedding_status = CASE WHEN item.deleted_at IS NULL THEN 'pending' ELSE item.embedding_status END,
         updated_at = now()
   WHERE item.group_id = (SELECT id FROM telegram_groups WHERE telegram_chat_id = '-1001787011433')
     AND item.content ~ 'Иль[а-яё]+-логист'
     AND item.content !~* '\mIlya_Demchenko\M'
     AND (SELECT count(*) FROM regexp_matches(item.content_normalized, 'иль[а-яё]+ логист', 'g'))
       = (SELECT count(*) FROM regexp_matches(item.content, 'Иль[а-яё]+-логист', 'g'))
   RETURNING item.id, item.created_at, item.deleted_at
)
INSERT INTO memory_embedding_jobs (memory_item_id, created_at)
SELECT id, created_at FROM fixed WHERE deleted_at IS NULL
ON CONFLICT (memory_item_id) DO UPDATE
   SET status = 'pending', attempts = 0, lease_token = NULL, lease_expires_at = NULL,
       last_error_code = NULL, updated_at = now();
