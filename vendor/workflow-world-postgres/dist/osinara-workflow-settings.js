/**
 * The Workflow Postgres pool and worker settings (vendored world, `index.js`, `createWorld`).
 *
 * Export:
 * - `workflowPostgresSettings`: the pool cap and the number of queue workers from the environment.
 *
 * Key construct:
 * - The package read both with `parseInt`: `-1` left the queue without workers, `0` became fifty,
 *   `30oops` became thirty (Codex review, 6 November 2026). A value is now a whole number within
 *   bounds or the start fails with `AGENT_RUNTIME_TUNING_INVALID`, as the other tuning settings do.
 *   An empty value counts as absent: compose writes an unset variable that way.
 */
const SETTING_BOUNDS = {
  WORKFLOW_POSTGRES_MAX_POOL_SIZE: { max: 500, min: 1 },
  WORKFLOW_POSTGRES_WORKER_CONCURRENCY: { max: 500, min: 1 },
}         ;
const DEFAULT_QUEUE_CONCURRENCY = 50;

function wholeSetting(
  name                             ,
  env                                              ,
)                     {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const bounds = SETTING_BOUNDS[name];
  const value = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(`AGENT_RUNTIME_TUNING_INVALID: ${name} должно быть целым от ${bounds.min} до ${bounds.max}`);
  }
  return value;
}

export function workflowPostgresSettings(
  env                                               = process.env,
)                                                                {
  return {
    maxPoolSize: wholeSetting("WORKFLOW_POSTGRES_MAX_POOL_SIZE", env),
    queueConcurrency: wholeSetting("WORKFLOW_POSTGRES_WORKER_CONCURRENCY", env) ?? DEFAULT_QUEUE_CONCURRENCY,
  };
}
