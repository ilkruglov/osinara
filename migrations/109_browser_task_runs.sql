-- One row per browser_task run so `confirm` and `resume` continue where the loop stopped,
-- across tool calls and agent restarts. Entered values are never stored, only field labels.
CREATE TABLE browser_task_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('personal', 'family')),
  sandbox_session_id text NOT NULL,
  goal text NOT NULL,
  start_url text,
  allowed_fields text[] NOT NULL DEFAULT '{}',
  extra_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  hint text,
  status text NOT NULL CHECK (status IN (
    'running', 'awaiting_confirmation', 'needs_plan', 'done', 'unverified', 'blocked', 'failed', 'cancelled'
  )),
  step_count integer NOT NULL DEFAULT 0,
  handoff_count integer NOT NULL DEFAULT 0,
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  entered jsonb NOT NULL DEFAULT '[]'::jsonb,
  pending_action jsonb,
  failed_actions jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_signature text,
  last_url text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX browser_task_runs_active_idx ON browser_task_runs (sandbox_session_id)
  WHERE status IN ('running', 'awaiting_confirmation', 'needs_plan');
