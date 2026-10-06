-- Since 1.6.0 (26 September 2026) an answer that used a record reinforces it once per seven days
-- (memory-reinforcement-repository.ts): a use counts when seven days passed since the last
-- COUNTED use. Uses before that were counted in use_count only: migration 106 moved them out of
-- reinforcement_count, and 1.6.0 started counting from its release. The rule is replayed here
-- over the full model_used history, so a record used in September ages as one used in October
-- does (6 October 2026). The walk is recursive because the window anchors on the last counted
-- reinforcement, not on the previous use; an explicit `remember_reinforces` always counts and
-- anchors the window too, exactly as at runtime (Codex review).
WITH RECURSIVE uses AS (
  SELECT event.memory_item_id, event.created_at, event.reason = 'remember_reinforces' AS explicit,
         row_number() OVER (PARTITION BY event.memory_item_id ORDER BY event.created_at) AS position
    FROM memory_reinforcement_events AS event
   WHERE event.reason IN ('model_used', 'remember_reinforces')
), walk AS (
  SELECT memory_item_id, position, created_at AS counted_at, 1 AS reinforcements
    FROM uses WHERE position = 1
  UNION ALL
  SELECT next.memory_item_id, next.position,
         CASE WHEN next.explicit OR next.created_at >= walk.counted_at + interval '7 days' THEN next.created_at ELSE walk.counted_at END,
         walk.reinforcements + CASE WHEN next.explicit OR next.created_at >= walk.counted_at + interval '7 days' THEN 1 ELSE 0 END
    FROM walk
    JOIN uses AS next ON next.memory_item_id = walk.memory_item_id AND next.position = walk.position + 1
), counted AS (
  SELECT DISTINCT ON (memory_item_id) memory_item_id, reinforcements, counted_at AS last_at
    FROM walk ORDER BY memory_item_id, position DESC
)
UPDATE memory_items_all AS item
   SET reinforcement_count = counted.reinforcements,
       last_reinforced_at = counted.last_at
  FROM counted
 WHERE counted.memory_item_id = item.id
   AND item.reinforcement_count < counted.reinforcements;
