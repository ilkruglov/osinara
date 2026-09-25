-- browser_task after review: the confirmed click is claimed durably before it happens, the time
-- budget counts loop time only, and the form profile belongs to a person, not to a workspace.
ALTER TABLE browser_task_runs DROP CONSTRAINT IF EXISTS browser_task_runs_status_check;
ALTER TABLE browser_task_runs ADD CONSTRAINT browser_task_runs_status_check CHECK (status IN (
  'running', 'awaiting_confirmation', 'confirming', 'needs_plan', 'done', 'unverified', 'blocked', 'failed', 'cancelled'
));
ALTER TABLE browser_task_runs ADD COLUMN IF NOT EXISTS active_millis integer NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS browser_task_runs_active_idx;
CREATE INDEX browser_task_runs_active_idx ON browser_task_runs (sandbox_session_id)
  WHERE status IN ('running', 'awaiting_confirmation', 'confirming', 'needs_plan');

-- One profile per person, readable from their private chat and from the family group alike.
-- Fields are {"phone": {"value": "...", "domains": ["site.ru"]}}; card and password fields are
-- refused in code before they reach this table.
CREATE TABLE IF NOT EXISTS browser_form_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
