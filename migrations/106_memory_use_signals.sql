-- Answer reuse is a utility signal, not a new observation of a fact.
ALTER TABLE memory_items_all
  ADD COLUMN use_count integer NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  ADD COLUMN last_used_at timestamptz;

-- Move only identifiable historical model-use signals. Preserve unclassified older evidence.
WITH signals AS (
  SELECT subject_id, count(*) FILTER (WHERE metadata->>'reason' = 'model_used')::integer AS uses,
         max(created_at) FILTER (WHERE metadata->>'reason' = 'model_used') AS last_use,
         max(created_at) FILTER (WHERE metadata->>'reason' IS DISTINCT FROM 'model_used') AS last_evidence
    FROM audit_events WHERE event_type = 'memory.reinforced' GROUP BY subject_id
)
UPDATE memory_items_all AS item
   SET use_count = signals.uses, last_used_at = signals.last_use,
       reinforcement_count = GREATEST(0, item.reinforcement_count - signals.uses),
       last_reinforced_at = CASE WHEN item.reinforcement_count > signals.uses
         THEN COALESCE(signals.last_evidence, item.last_reinforced_at) ELSE NULL END
  FROM signals WHERE signals.subject_id = item.id AND signals.uses > 0;

CREATE TABLE memory_reinforcement_events (
  memory_item_id uuid NOT NULL REFERENCES memory_items_all(id) ON DELETE CASCADE,
  eve_session_id text NOT NULL,
  eve_turn_id text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('model_used', 'remember_reinforces')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_item_id, eve_session_id, eve_turn_id, reason)
);

INSERT INTO memory_reinforcement_events (memory_item_id, eve_session_id, eve_turn_id, reason, created_at)
SELECT item.id, audit.metadata->>'sessionId', audit.metadata->>'turnId', audit.metadata->>'reason', min(audit.created_at)
  FROM audit_events AS audit JOIN memory_items_all AS item ON item.id = audit.subject_id
 WHERE audit.event_type = 'memory.reinforced'
   AND audit.metadata->>'reason' IN ('model_used', 'remember_reinforces')
   AND jsonb_typeof(audit.metadata->'sessionId') = 'string'
   AND jsonb_typeof(audit.metadata->'turnId') = 'string'
 GROUP BY item.id, audit.metadata->>'sessionId', audit.metadata->>'turnId', audit.metadata->>'reason';

CREATE OR REPLACE VIEW memory_items AS
  SELECT * FROM memory_items_all WHERE deleted_at IS NULL;
