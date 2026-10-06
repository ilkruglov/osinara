-- Since 1.6.0 (26 September 2026) an answer that used a record reinforces it once per seven days
-- (memory-reinforcement-repository.ts). Uses before that were counted in use_count only:
-- migration 106 moved them out of reinforcement_count, and 1.6.0 started counting from its
-- release. The 7-day rule is replayed here over the full model_used history, so a record used
-- in September ages as one used in October does (6 October 2026).
WITH ordered AS (
  SELECT event.memory_item_id, event.created_at,
         lag(event.created_at) OVER (PARTITION BY event.memory_item_id ORDER BY event.created_at) AS previous_at
    FROM memory_reinforcement_events AS event
   WHERE event.reason = 'model_used'
), counted AS (
  SELECT memory_item_id, count(*) AS reinforcements, max(created_at) AS last_at
    FROM ordered
   WHERE previous_at IS NULL OR created_at >= previous_at + interval '7 days'
   GROUP BY memory_item_id
)
UPDATE memory_items_all AS item
   SET reinforcement_count = counted.reinforcements,
       last_reinforced_at = counted.last_at
  FROM counted
 WHERE counted.memory_item_id = item.id
   AND item.reinforcement_count < counted.reinforcements;
