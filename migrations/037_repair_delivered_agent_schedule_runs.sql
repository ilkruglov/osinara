-- A Telegram delivery receipt is durable proof that replay is forbidden and the historical run
-- succeeded, even when an older release missed the later turn-completion transition.
WITH delivered AS (
  SELECT source_id AS run_id, max(delivered_at) AS delivered_at
    FROM proactive_deliveries
   WHERE source_kind = 'agent_schedule'
   GROUP BY source_id
)
UPDATE agent_schedule_runs AS run
   SET status = 'completed',
       completed_at = delivered.delivered_at,
       error_code = NULL,
       updated_at = greatest(run.updated_at, delivered.delivered_at)
  FROM delivered
 WHERE run.id = delivered.run_id
   AND run.status IN ('running', 'ambiguous');
