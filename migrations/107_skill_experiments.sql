-- Isolated file experiments are separate from conversation trial observations.
CREATE TABLE authored_skill_experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  base_version integer NOT NULL,
  baseline jsonb,
  protocol jsonb NOT NULL,
  protocol_hash text NOT NULL,
  model_config_hash text NOT NULL,
  operation_key text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','running','completed','interrupted','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (family_id, operation_key)
);
CREATE TABLE authored_skill_experiment_candidates (
  experiment_id uuid NOT NULL REFERENCES authored_skill_experiments(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES authored_skill_candidates(id) ON DELETE CASCADE,
  parent_candidate_id uuid REFERENCES authored_skill_candidates(id),
  PRIMARY KEY (experiment_id, candidate_id)
);
CREATE TABLE authored_skill_experiment_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES authored_skill_experiments(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  variant text NOT NULL,
  case_id text NOT NULL,
  partition text NOT NULL CHECK (partition IN ('development','holdout')),
  repetition integer NOT NULL CHECK (repetition IN (0,1)),
  content_hash text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','interrupted')),
  passed jsonb NOT NULL DEFAULT '[]'::jsonb,
  telemetry jsonb NOT NULL DEFAULT '{}'::jsonb,
  artifact_hashes jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE(experiment_id, ordinal)
);
CREATE INDEX authored_skill_experiments_family ON authored_skill_experiments(family_id, created_at DESC);
ALTER TABLE authored_skill_versions ADD COLUMN evaluation_experiment_id uuid REFERENCES authored_skill_experiments(id);
