/** Owner-scoped frozen protocols, candidate ancestry and at-most-once experiment reservations. */
import type { PoolClient } from "pg";
import { database } from "../database.js";
import type { FamilyCaller } from "../family-context.js";
import { AppError } from "../app-error.js";
import { modelProviderConfig } from "../model-provider-config.js";
import { requireCurrentOwner } from "./authored-skill-owner.js";
import { type AuthoredSkillDraft, isReservedSkillName, AUTHORED_SKILL_NAME_PATTERN } from "./authored-skill-contract.js";
import { assertExperimentSkill, type ScenarioToolContracts } from "./skill-scenario.js";
import { captureScenarioContracts } from "./skill-scenario-contracts.js";
import { skillContentHash } from "./skill-evaluation.js";
import { experimentHash, experimentProtocolSchema, planExperiment, publicExperimentResults, type ExperimentProtocol } from "./skill-experiment.js";
export { experimentHash } from "./skill-experiment.js";

export interface Experiment {
  id: string; family_id: string; name: string; base_version: number; baseline: AuthoredSkillDraft | null;
  protocol: ExperimentProtocol; protocol_hash: string; model_config_hash: string;
  status: string; created_at: Date; started_at: Date | null;
  tool_contracts: ScenarioToolContracts; tool_contracts_hash: string | null;
}
export interface ExperimentCandidate { id: string; draft: AuthoredSkillDraft; content_hash: string; base_version: number; created_at: Date }
export interface ExperimentRun {
  id: string; variant: string; case_id: string; partition: string; repetition: number;
  status: string; passed: boolean[]; telemetry: Record<string, unknown>; [key: string]: unknown;
}
export interface ExperimentBatch { experiment: Experiment; candidates: ExperimentCandidate[]; runs: ExperimentRun[] }
async function owned<T>(caller: FamilyCaller, work: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await database().connect();
  try { await c.query("BEGIN"); await requireCurrentOwner(c, caller); const value = await work(c); await c.query("COMMIT"); return value; }
  catch (error) { await c.query("ROLLBACK"); throw error; } finally { c.release(); }
}
async function get(c: PoolClient, caller: FamilyCaller, id: string): Promise<Experiment> {
  // A disappeared worker leaves unknown evidence, never a resumable model call.
  await c.query(`UPDATE authored_skill_experiments SET status='interrupted',finished_at=now()
    WHERE id=$1 AND family_id=$2 AND status='running'
      AND started_at < now() - ((protocol->>'maxSeconds')::int + 30) * interval '1 second'`, [id, caller.familyId]);
  const e = (await c.query<Experiment>("SELECT * FROM authored_skill_experiments WHERE id=$1 AND family_id=$2 FOR UPDATE", [id, caller.familyId])).rows[0];
  if (!e) throw new AppError("AGENT_SKILL_EXPERIMENT_NOT_FOUND", "Эксперимент не найден");
  if (["cancelled", "interrupted"].includes(e.status)) {
    await c.query("UPDATE authored_skill_experiment_runs SET status='interrupted',finished_at=now() WHERE experiment_id=$1 AND status IN ('pending','running')", [id]);
  }
  return e;
}
async function currentVersion(c: PoolClient, familyId: string, name: string): Promise<number> {
  return (await c.query<{ version: number }>("SELECT version FROM authored_skills WHERE family_id=$1 AND name=$2 AND status='active'", [familyId, name])).rows[0]?.version ?? 0;
}
export const skillExperimentRepository = {
  async list(caller: FamilyCaller, name: string) {
    return owned(caller, async (c) => (await c.query(`SELECT id,name,status,base_version,protocol_hash,created_at
      FROM authored_skill_experiments WHERE family_id=$1 AND name=$2 ORDER BY created_at DESC LIMIT 10`, [caller.familyId,name])).rows);
  },
  async create(caller: FamilyCaller, name: string, input: unknown, operationKey: string, chatKind: "private" | "family" = "private") {
    const protocol = experimentProtocolSchema.parse(input);
    if (!AUTHORED_SKILL_NAME_PATTERN.test(name) || isReservedSkillName(name)) throw new AppError("AGENT_SKILL_EXPERIMENT_UNSUPPORTED", "Испытания доступны только собственным навыкам Мии");
    return owned(caller, async (c) => {
      await c.query("SELECT id FROM families WHERE id=$1 FOR UPDATE", [caller.familyId]);
      const previous = (await c.query<Experiment>("SELECT * FROM authored_skill_experiments WHERE family_id=$1 AND operation_key=$2", [caller.familyId, operationKey])).rows[0];
      if (previous) return { id: previous.id, protocolHash: previous.protocol_hash };
      const contracts = await captureScenarioContracts(protocol, chatKind);
      const count = (await c.query("SELECT count(*)::int AS n FROM authored_skill_experiments WHERE family_id=$1 AND created_at > now()-interval '1 day'", [caller.familyId])).rows[0].n;
      if (count >= 3) throw new AppError("AGENT_SKILL_EXPERIMENT_LIMIT", "Лимит: три протокола в сутки на семью");
      const baseline = (await c.query<AuthoredSkillDraft & { version: number }>("SELECT name,description,markdown,files,version FROM authored_skills WHERE family_id=$1 AND name=$2 AND status='active'", [caller.familyId, name])).rows[0] ?? null;
      if (baseline) assertExperimentSkill(baseline, protocol, contracts);
      const hash = experimentHash(protocol);
      const result = await c.query<Experiment>(`INSERT INTO authored_skill_experiments
        (family_id,created_by_user_id,name,base_version,baseline,protocol,protocol_hash,model_config_hash,operation_key,tool_contracts,tool_contracts_hash)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [caller.familyId, caller.userId, name, baseline?.version ?? 0, JSON.stringify(baseline), JSON.stringify(protocol), hash, experimentHash(modelProviderConfig.agent), operationKey, JSON.stringify(contracts), experimentHash(contracts)]);
      return { id: result.rows[0]!.id, protocolHash: hash };
    });
  },
  async enroll(caller: FamilyCaller, id: string, candidateId: string, parentId?: string) {
    return owned(caller, async (c) => {
      const e = await get(c, caller, id);
      if (e.status !== "draft") throw new AppError("AGENT_SKILL_EXPERIMENT_FROZEN", "Состав запущенного эксперимента менять нельзя");
      const candidate = (await c.query<ExperimentCandidate & { name: string }>(`SELECT * FROM authored_skill_candidates
        WHERE id=$1 AND family_id=$2 AND created_at > (SELECT created_at FROM authored_skill_experiments WHERE id=$3)`, [candidateId, caller.familyId,id])).rows[0];
      if (!candidate || candidate.name !== e.name || candidate.base_version !== e.base_version) {
        throw new AppError("AGENT_SKILL_EXPERIMENT_CANDIDATE", "Нужен черновик этого навыка и базовой версии, созданный после фиксации протокола");
      }
      assertExperimentSkill(candidate.draft, e.protocol, e.tool_contracts);
      const existing = await c.query("SELECT candidate_id FROM authored_skill_experiment_candidates WHERE experiment_id=$1", [id]);
      if (parentId === candidateId || (parentId && !existing.rows.some((r) => r.candidate_id === parentId))) {
        throw new AppError("AGENT_SKILL_EXPERIMENT_PARENT", "Родитель должен быть ранее добавленным кандидатом этого эксперимента");
      }
      if (existing.rows.some((r) => r.candidate_id === candidateId)) return { enrolled: true };
      if (existing.rows.length >= 3) throw new AppError("AGENT_SKILL_EXPERIMENT_LIMIT", "Не более трёх кандидатов");
      await c.query("INSERT INTO authored_skill_experiment_candidates (experiment_id,candidate_id,parent_candidate_id) VALUES ($1,$2,$3)", [id,candidateId,parentId ?? null]);
      return { enrolled: true };
    });
  },
  async start(caller: FamilyCaller, id: string): Promise<ExperimentBatch | null> {
    return owned(caller, async (c) => {
      await c.query("SELECT id FROM families WHERE id=$1 FOR UPDATE", [caller.familyId]);
      const e = await get(c, caller, id);
      if (e.status !== "draft") return null;
      if (e.model_config_hash !== experimentHash(modelProviderConfig.agent) || await currentVersion(c, caller.familyId, e.name) !== e.base_version) {
        throw new AppError("AGENT_SKILL_EXPERIMENT_STALE", "Модель или базовая версия изменились: нужен новый протокол");
      }
      if (e.protocol_hash !== experimentHash(e.protocol) || e.tool_contracts_hash && e.tool_contracts_hash !== experimentHash(e.tool_contracts)) throw new AppError("AGENT_SKILL_EXPERIMENT_STALE", "Протокол или контракты инструментов изменились");
      const busy = await c.query(`SELECT id FROM authored_skill_experiments WHERE family_id=$1 AND status='running'
        AND started_at > now() - ((protocol->>'maxSeconds')::int + 30) * interval '1 second'`, [caller.familyId]);
      if (busy.rowCount) throw new AppError("AGENT_SKILL_EXPERIMENT_BUSY", "В семье уже выполняется эксперимент");
      const candidates = (await c.query<ExperimentCandidate>(`SELECT c.* FROM authored_skill_candidates c
        JOIN authored_skill_experiment_candidates ec ON ec.candidate_id=c.id WHERE ec.experiment_id=$1 ORDER BY c.created_at,c.id`, [id])).rows;
      if (!candidates.length) throw new AppError("AGENT_SKILL_EXPERIMENT_EMPTY", "Сначала добавь кандидатов");
      const plan = planExperiment(e.protocol, candidates.map((v) => v.id));
      for (const [ordinal, run] of plan.entries()) {
        const pkg = run.variant === "baseline" ? e.baseline : candidates.find((v) => v.id === run.variant)!.draft;
        await c.query(`INSERT INTO authored_skill_experiment_runs (experiment_id,ordinal,variant,case_id,partition,repetition,content_hash)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id,ordinal,run.variant,run.caseId,run.partition,run.repeat,pkg ? skillContentHash(pkg) : null]);
      }
      await c.query("UPDATE authored_skill_experiments SET status='running',started_at=now() WHERE id=$1", [id]);
      return { experiment: e, candidates, runs: (await c.query<ExperimentRun>("SELECT * FROM authored_skill_experiment_runs WHERE experiment_id=$1 ORDER BY ordinal", [id])).rows };
    });
  },
  async status(caller: FamilyCaller, id: string) {
    return owned(caller, async (c) => {
      const e = await get(c, caller, id);
      const runs = (await c.query<ExperimentRun>("SELECT * FROM authored_skill_experiment_runs WHERE experiment_id=$1 ORDER BY ordinal", [id])).rows;
      const ancestry = (await c.query("SELECT candidate_id,parent_candidate_id FROM authored_skill_experiment_candidates WHERE experiment_id=$1", [id])).rows;
      return { id, status: e.status, baseVersion: e.base_version, protocolHash: e.protocol_hash,
        evidenceScope: e.protocol.environment === "scenario" ? "simulated_tools" : "isolated_files",
        qualityAssessment: e.protocol.cases.some((v) => v.checks.some((check) => "target" in check && check.target === "rubric")) ? "independent_model_rubric" : "deterministic_checks",
        toolContractsHash: e.tool_contracts_hash,
        genericScenarioTools: Object.entries(e.tool_contracts).filter(([, v]) => v.source === "generic_scenario").map(([name]) => name),
        modelConfigHash: e.model_config_hash, costScope: "isolated_runs_only", ancestry, results: publicExperimentResults(runs),
        telemetry: runs.map((r) => ({ runId: r.id, variant: r.variant, status: r.status, ...r.telemetry })) };
    });
  },
  async isRunning(caller: FamilyCaller, id: string) { return owned(caller, async (c) => (await get(c, caller, id)).status === "running"); },
  async cancel(caller: FamilyCaller, id: string) {
    return owned(caller, async (c) => {
      await get(c, caller, id);
      await c.query("UPDATE authored_skill_experiments SET status='cancelled',finished_at=now() WHERE id=$1 AND status IN ('draft','running')", [id]);
      await c.query("UPDATE authored_skill_experiment_runs SET status='interrupted',finished_at=now() WHERE experiment_id=$1 AND status IN ('pending','running')", [id]);
      return { cancelled: true };
    });
  },
  async reserveRun(caller: FamilyCaller, experimentId: string, runId: string): Promise<boolean> {
    return owned(caller, async (c) => {
      if ((await get(c, caller, experimentId)).status !== "running") return false;
      return !!(await c.query("UPDATE authored_skill_experiment_runs SET status='running',started_at=now() WHERE id=$1 AND experiment_id=$2 AND status='pending'", [runId,experimentId])).rowCount;
    });
  },
  async completeRun(experimentId: string, runId: string, result: { status: "completed" | "interrupted"; passed: boolean[]; telemetry: Record<string, unknown>; artifactHashes: Record<string, string> }) {
    await database().query(`UPDATE authored_skill_experiment_runs SET status=$3,passed=$4,telemetry=$5,artifact_hashes=$6,finished_at=now()
      WHERE id=$1 AND experiment_id=$2 AND status='running'`, [runId,experimentId,result.status,JSON.stringify(result.passed),JSON.stringify(result.telemetry),JSON.stringify(result.artifactHashes)]);
  },
  async finish(id: string) {
    await database().query(`UPDATE authored_skill_experiments SET status=CASE WHEN EXISTS
      (SELECT 1 FROM authored_skill_experiment_runs WHERE experiment_id=$1 AND status<>'completed') THEN 'interrupted' ELSE 'completed' END,
      finished_at=now() WHERE id=$1 AND status='running'`, [id]);
    await database().query("UPDATE authored_skill_experiment_runs SET status='interrupted',finished_at=now() WHERE experiment_id=$1 AND status IN ('pending','running')", [id]);
  },
};
