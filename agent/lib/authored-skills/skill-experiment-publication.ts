/** Publication checks real, complete paired evidence, within the existing family publication lock. */
import type { PoolClient } from "pg";
import { AppError } from "../app-error.js";
import { modelProviderConfig } from "../model-provider-config.js";
import { experimentHash, type Experiment, type ExperimentRun } from "./skill-experiment-repository.js";
import { skillContentHash } from "./skill-evaluation.js";
import { type AuthoredSkillDraft } from "./authored-skill-contract.js";
import { type AuthoredSkillExample } from "./authored-skill-example-repository.js";

export async function verifySkillExperiment(c: PoolClient, familyId: string, experimentId: string, candidateId: string,
  draft: AuthoredSkillDraft, baseVersion: number, examples: readonly AuthoredSkillExample[], trialRequest?: string) {
  const e = (await c.query<Experiment>(`SELECT e.* FROM authored_skill_experiments e
    JOIN authored_skill_experiment_candidates ec ON ec.experiment_id=e.id
    WHERE e.id=$1 AND e.family_id=$2 AND ec.candidate_id=$3 FOR SHARE OF e`, [experimentId,familyId,candidateId])).rows[0];
  const fail = () => { throw new AppError("AGENT_SKILL_EXPERIMENT_EVIDENCE", "Нужен завершённый парный эксперимент с этим кандидатом, протоколом и всеми сохранёнными примерами"); };
  if (!e || e.status !== "completed" || e.base_version !== baseVersion || e.name !== draft.name ||
    e.model_config_hash !== experimentHash(modelProviderConfig.agent) || e.protocol_hash !== experimentHash(e.protocol) ||
    (e.tool_contracts_hash !== null && e.tool_contracts_hash !== experimentHash(e.tool_contracts))) return fail();
  if (!e.protocol.cases.some((v) => v.request === trialRequest?.trim()) ||
    examples.some((v) => !e.protocol.cases.some((test) => test.request === v.request))) return fail();
  const runs = (await c.query<ExperimentRun>("SELECT * FROM authored_skill_experiment_runs WHERE experiment_id=$1 AND variant IN ('baseline',$2)", [experimentId,candidateId])).rows;
  if (runs.length !== e.protocol.cases.length * 4) return fail();
  for (const test of e.protocol.cases) for (const repeat of [0,1]) for (const variant of ["baseline",candidateId]) {
    const run = runs.find((r) => r.case_id === test.id && r.repetition === repeat && r.variant === variant);
    const expectedHash = variant === "baseline" ? e.baseline ? skillContentHash(e.baseline) : null : skillContentHash(draft);
    if (!run || run.status !== "completed" || run.content_hash !== expectedHash || run.passed.length !== test.checks.length ||
      (variant === candidateId && !run.passed.every(Boolean))) return fail();
    if (e.protocol.environment === "scenario" && (run.telemetry.evidenceScope !== "simulated_tools" || run.telemetry.toolContractsHash !== e.tool_contracts_hash || run.telemetry.coverageComplete !== true)) return fail();
  }
}
