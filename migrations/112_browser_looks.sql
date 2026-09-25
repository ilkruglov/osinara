-- The last look at the browser of one trust zone: what the model was shown, numbered by epoch,
-- what was typed on this site, and the one click waiting for a confirmation. One row per sandbox
-- session (a family group shares one), owned by the person who looked; the row is rewritten by
-- every look and cleared by a session reset.
CREATE TABLE browser_looks (
  sandbox_session_id text PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  -- The person whose turn made the look: only they act on it, confirm its click, or keep its typed data.
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  epoch text NOT NULL,
  url text NOT NULL,
  title text NOT NULL DEFAULT '',
  elements jsonb NOT NULL DEFAULT '[]'::jsonb,
  view_hash text NOT NULL,
  text_hash integer NOT NULL DEFAULT 0,
  state_hash integer NOT NULL DEFAULT 0,
  view jsonb,
  screenshot_path text,
  entered jsonb NOT NULL DEFAULT '[]'::jsonb,
  pending jsonb,
  steps integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- browser_task and its Jev loop are gone with 1.3.0; nothing reads its runs.
DROP TABLE IF EXISTS browser_task_runs;
