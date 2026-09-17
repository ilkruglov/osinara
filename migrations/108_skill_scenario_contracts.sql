-- Freeze model-visible scenario descriptors independently of the changing production catalog.
ALTER TABLE authored_skill_experiments
  ADD COLUMN tool_contracts jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN tool_contracts_hash text;
