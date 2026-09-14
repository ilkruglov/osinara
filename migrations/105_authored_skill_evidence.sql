-- Old evaluations remain historical, with unknown provenance and version.
ALTER TABLE authored_skill_usage
  ADD COLUMN skill_version integer,
  ADD COLUMN usage_key text UNIQUE,
  ADD COLUMN outcome_source text CHECK (outcome_source IN ('owner', 'verification')),
  ADD COLUMN execution_status text CHECK (execution_status IN ('completed', 'failed')),
  ADD COLUMN execution_note text,
  ADD COLUMN step_count integer CHECK (step_count >= 0),
  ADD COLUMN completed_at timestamptz;

CREATE TABLE authored_skill_turn_versions (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  eve_session_id text NOT NULL,
  eve_turn_id text NOT NULL,
  skill_id uuid NOT NULL REFERENCES authored_skills(id) ON DELETE CASCADE,
  version integer NOT NULL,
  PRIMARY KEY (eve_session_id, eve_turn_id, skill_id)
);

-- Candidate content is immutable; editing produces a new candidate and invalidates its trials.
CREATE TABLE authored_skill_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name text NOT NULL,
  base_version integer NOT NULL,
  content_hash text NOT NULL,
  draft jsonb NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, operation_key)
);
CREATE TABLE authored_skill_trial_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES authored_skill_candidates(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  example_id uuid REFERENCES authored_skill_examples(id),
  variant text NOT NULL CHECK (variant IN ('baseline', 'candidate')),
  eve_session_id text NOT NULL,
  eve_turn_id text NOT NULL,
  operation_key text NOT NULL,
  request text NOT NULL,
  checks jsonb NOT NULL,
  passed jsonb NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'checked', 'cancelled')),
  summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (family_id, operation_key)
);
CREATE UNIQUE INDEX authored_skill_trial_running ON authored_skill_trial_runs (eve_session_id, eve_turn_id)
  WHERE status = 'running';
CREATE TABLE authored_skill_trial_events (
  run_id uuid NOT NULL REFERENCES authored_skill_trial_runs(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  tool_name text NOT NULL,
  succeeded boolean NOT NULL,
  result_hash text NOT NULL,
  matched_checks jsonb NOT NULL,
  PRIMARY KEY (run_id, event_id)
);

ALTER TABLE authored_skill_candidates ADD COLUMN selection_evaluation jsonb;
CREATE TABLE authored_skill_improvement_requests (
  skill_id uuid NOT NULL REFERENCES authored_skills(id) ON DELETE CASCADE,
  version integer NOT NULL,
  conversation_id uuid NOT NULL REFERENCES application_conversations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, version, conversation_id)
);
ALTER TABLE conversation_skill_hints DROP CONSTRAINT conversation_skill_hints_kind_check;
ALTER TABLE conversation_skill_hints ADD CONSTRAINT conversation_skill_hints_kind_check CHECK (kind IN ('repeat','backlog','improve'));
ALTER TABLE conversation_skill_hints DROP CONSTRAINT conversation_skill_hints_kind_shape;
ALTER TABLE conversation_skill_hints ADD CONSTRAINT conversation_skill_hints_kind_shape CHECK (
  (kind='repeat' AND step_count IS NOT NULL AND summary IS NULL) OR (kind IN ('backlog','improve') AND summary IS NOT NULL)
);
ALTER TABLE authored_skill_versions
  ADD COLUMN evaluation_candidate_id uuid REFERENCES authored_skill_candidates(id),
  ADD COLUMN evaluation_run_id uuid REFERENCES authored_skill_trial_runs(id);
