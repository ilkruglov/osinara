/** Immutable skill candidates and bounded, provenance-bound observations of manual trial runs.
 * No tool is executed here. Result bodies stay out of the ledger; only check matches and hashes persist.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { createReflectionRateLimiter } from "../improvements/reflection.js";
import { evaluateSkillSelection, type SkillSelectionCase } from "./skill-selection.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { FamilyCaller } from "../family-context.js";
import { assertAuthoredSkillDraft, type AuthoredSkillDraft } from "./authored-skill-contract.js";
import { requireCurrentOwner } from "./authored-skill-owner.js";
import { evaluateTrial, skillCheckSchema, skillContentHash, type SkillCheck, type ObservedSkillResult } from "./skill-evaluation.js";
import type { AuthoredSkillExample } from "./authored-skill-example-repository.js";

const selectionLimiter = createReflectionRateLimiter(6);

type Provenance = { eveSessionId: string; eveTurnId: string };
export type SkillPublicationEvidence = { candidateId: string; runId: string };
interface Candidate { id: string; family_id: string; name: string; base_version: number; content_hash: string; draft: AuthoredSkillDraft; selection_evaluation: { candidate: { passed: boolean[] }; cases: SkillSelectionCase[] } | null }
interface Run { request: string; id: string; candidate_id: string; example_id: string | null; variant: string; checks: SkillCheck[]; passed: boolean[]; status: string; summary: string | null }

async function owned<T>(caller: FamilyCaller, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await requireCurrentOwner(client, caller);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export const skillEvaluationRepository = {
  async draft(caller: FamilyCaller, draft: AuthoredSkillDraft, operationKey: string, knownToolNames: ReadonlySet<string>): Promise<Candidate> {
    assertAuthoredSkillDraft(draft, { knownToolNames });
    return owned(caller, async (client) => {
      // Bound abandoned drafts, without deleting history or evicting a candidate under evaluation.
      const existing = await client.query<Candidate>("SELECT * FROM authored_skill_candidates WHERE family_id=$1 AND operation_key=$2", [caller.familyId, operationKey]);
      if (existing.rows[0]) return existing.rows[0];
      await client.query("SELECT id FROM families WHERE id=$1 FOR UPDATE", [caller.familyId]);
      const count = await client.query<{ count: string }>("SELECT count(*) FROM authored_skill_candidates WHERE family_id=$1 AND created_at > now() - interval '1 day'", [caller.familyId]);
      if (Number(count.rows[0]!.count) >= 20) throw new AppError("AGENT_SKILL_DRAFT_LIMIT", "Лимит: 20 черновиков в сутки");
      const result = await client.query<Candidate>(
        `INSERT INTO authored_skill_candidates (family_id, name, base_version, content_hash, draft, created_by_user_id, operation_key)
         VALUES ($1,$2,COALESCE((SELECT version FROM authored_skills WHERE family_id=$1 AND name=$2 AND status='active'),0),$3,$4::jsonb,$5,$6)
         RETURNING *`, [caller.familyId, draft.name, skillContentHash(draft), JSON.stringify(draft), caller.userId, operationKey],
      );
      return result.rows[0]!;
    });
  },

  async list(familyId: string, name: string) {
    return (await database().query(
      `SELECT c.id, c.base_version, c.draft, c.selection_evaluation, c.created_at,
         (SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM (
           SELECT t.id,t.example_id,t.variant,t.request,t.checks,t.passed,t.status,t.summary,t.created_at,t.finished_at,
             (SELECT count(*) FROM authored_skill_trial_events e WHERE e.run_id=t.id) AS observed_calls
           FROM authored_skill_trial_runs t WHERE t.candidate_id=c.id ORDER BY t.created_at DESC LIMIT 24
         ) r) AS runs
       FROM authored_skill_candidates c WHERE c.family_id=$1 AND c.name=$2 ORDER BY c.created_at DESC LIMIT 3`, [familyId, name],
    )).rows;
  },

  async testSelection(caller: FamilyCaller, candidateId: string, cases: readonly SkillSelectionCase[]) {
    if (cases.length < 2 || cases.length > 6 || !cases.some((item) => item.shouldLoad) || !cases.some((item) => !item.shouldLoad)) {
      throw new AppError("AGENT_SKILL_SELECTION_CASES", "Нужны 2–6 примеров: хотя бы один положительный и один отрицательный");
    }
    const { candidate, catalog } = await owned(caller, async (client) => {
      const candidate = (await client.query<Candidate>("SELECT * FROM authored_skill_candidates WHERE id=$1 AND family_id=$2", [candidateId,caller.familyId])).rows[0];
      if (!candidate) throw new AppError("AGENT_SKILL_CANDIDATE_NOT_FOUND", "Черновик не найден");
      const catalog = (await client.query<{ name: string; description: string }>(
        "SELECT name,description FROM authored_skills WHERE family_id=$1 AND status='active' ORDER BY name", [caller.familyId],
      )).rows;
      return { candidate, catalog };
    });
    if (!selectionLimiter.admit(caller.familyId)) throw new AppError("AGENT_SKILL_SELECTION_LIMIT", "Лимит: 6 проверок выбора в час");
    const baseline = candidate.base_version === 0 ? null : await evaluateSkillSelection(candidate.name, catalog, cases);
    const evaluated = await evaluateSkillSelection(candidate.name,
      [...catalog.filter((skill) => skill.name !== candidate.name), { name: candidate.name, description: candidate.draft.description }], cases);
    const evaluation = { baseline, candidate: evaluated, cases, evaluatedAt: new Date().toISOString() };
    await owned(caller, async (client) => {
      await client.query("UPDATE authored_skill_candidates SET selection_evaluation=$3::jsonb WHERE id=$1 AND family_id=$2", [candidateId,caller.familyId,JSON.stringify(evaluation)]);
    });
    return evaluation;
  },

  async begin(caller: FamilyCaller, input: Provenance & {
    candidateId: string; exampleId?: string; request?: string; variant: "baseline" | "candidate";
    operationKey: string; checks: readonly SkillCheck[];
  }): Promise<Run> {
    const checks = skillCheckSchema.array().min(1).max(10).parse(input.checks);
    if (checks.some((check) => check.toolName === "manage_skill")) throw new AppError("AGENT_SKILL_TRIAL_CHECK_INVALID", "Служебный вызов не доказывает выполнение навыка");
    return owned(caller, async (client) => {
      const replay = await client.query<Run>("SELECT * FROM authored_skill_trial_runs WHERE family_id=$1 AND operation_key=$2", [caller.familyId, input.operationKey]);
      if (replay.rows[0]) return replay.rows[0];
      const candidate = (await client.query<Candidate>("SELECT * FROM authored_skill_candidates WHERE family_id=$1 AND id=$2 FOR SHARE", [caller.familyId, input.candidateId])).rows[0];
      if (!candidate) throw new AppError("AGENT_SKILL_CANDIDATE_NOT_FOUND", "Черновик не найден");
      if (input.variant === "baseline" && candidate.base_version === 0) throw new AppError("AGENT_SKILL_TRIAL_NO_BASELINE", "У первой версии нет baseline");
      let request = input.request?.trim() ?? "";
      if (input.exampleId) {
        const example = await client.query(
          `SELECT e.request FROM authored_skill_examples AS e JOIN authored_skills AS s ON s.id=e.skill_id
           WHERE e.id=$1 AND e.active AND s.family_id=$2 AND s.name=$3`, [input.exampleId, caller.familyId, candidate.name],
        );
        if (!example.rowCount) throw new AppError("AGENT_SKILL_EVAL_UNKNOWN_EXAMPLE", "Пример не принадлежит навыку");
        request = example.rows[0].request;
      }
      if (request.length === 0 || request.length > 1000) throw new AppError("AGENT_SKILL_TRIAL_REQUEST_REQUIRED", "Укажи request пробного прогона");
      const result = await client.query<Run>(
        `INSERT INTO authored_skill_trial_runs (candidate_id,family_id,example_id,variant,eve_session_id,eve_turn_id,operation_key,checks,passed,request)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10) RETURNING *`,
        [candidate.id,caller.familyId,input.exampleId ?? null,input.variant,input.eveSessionId,input.eveTurnId,input.operationKey,JSON.stringify(checks),JSON.stringify(checks.map(() => false)),request],
      );
      return result.rows[0]!;
    });
  },

  async observe(input: Provenance & ObservedSkillResult & { familyId: string; eventId: string }): Promise<void> {
    if (input.toolName === "manage_skill") return;
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const run = (await client.query<Run>(
        `SELECT * FROM authored_skill_trial_runs WHERE family_id=$1 AND eve_session_id=$2 AND eve_turn_id=$3
         AND status='running' AND created_at > now() - interval '1 hour' FOR UPDATE`, [input.familyId, input.eveSessionId, input.eveTurnId],
      )).rows[0];
      if (run) {
        const matches = evaluateTrial(run.checks, [input]);
        await client.query(
          `INSERT INTO authored_skill_trial_events (run_id,event_id,tool_name,succeeded,result_hash,matched_checks)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`,
          [run.id,input.eventId,input.toolName,input.succeeded,createHash("sha256").update(JSON.stringify(input.output) ?? "null").digest("hex"),JSON.stringify(matches)],
        );
        await client.query("UPDATE authored_skill_trial_runs SET passed=$2::jsonb WHERE id=$1", [run.id, JSON.stringify(run.passed.map((passed, index) => passed || matches[index]))]);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  },

  async cancel(caller: FamilyCaller, runId: string, provenance: Provenance) {
    return owned(caller, async (client) => {
      const result = await client.query(
        `UPDATE authored_skill_trial_runs SET status='cancelled',finished_at=now()
         WHERE id=$1 AND family_id=$2 AND eve_session_id=$3 AND eve_turn_id=$4 AND status='running' RETURNING id,status`,
        [runId,caller.familyId,provenance.eveSessionId,provenance.eveTurnId],
      );
      return { cancelled: (result.rowCount ?? 0) > 0 };
    });
  },

  async finish(caller: FamilyCaller, runId: string, provenance: Provenance, summary: string): Promise<Run> {
    return owned(caller, async (client) => {
      const run = (await client.query<Run>(
        `SELECT * FROM authored_skill_trial_runs WHERE id=$1 AND family_id=$2 AND eve_session_id=$3 AND eve_turn_id=$4 FOR UPDATE`,
        [runId,caller.familyId,provenance.eveSessionId,provenance.eveTurnId],
      )).rows[0];
      if (!run) throw new AppError("AGENT_SKILL_TRIAL_NOT_FOUND", "Прогон не принадлежит этому ходу");
      if (run.status === "checked") return run;
      if (run.status !== "running") throw new AppError("AGENT_SKILL_TRIAL_CANCELLED", "Прогон отменён");
      const count = await client.query("SELECT 1 FROM authored_skill_trial_events WHERE run_id=$1 LIMIT 1", [run.id]);
      if (!count.rowCount) throw new AppError("AGENT_SKILL_TRIAL_NO_EVIDENCE", "Нет наблюдаемых результатов инструментов");
      return (await client.query<Run>(
        "UPDATE authored_skill_trial_runs SET status='checked', summary=$2, finished_at=now() WHERE id=$1 RETURNING *", [run.id,summary.slice(0,1000)],
      )).rows[0]!;
    });
  },

  /** Called under the publication's family lock; an update invalidates both candidate and baseline. */
  async verify(client: PoolClient, familyId: string, evidence: SkillPublicationEvidence, draft: AuthoredSkillDraft, baseVersion: number, examples: readonly AuthoredSkillExample[], trialRequest?: string): Promise<void> {
    const candidate = (await client.query<Candidate>("SELECT * FROM authored_skill_candidates WHERE id=$1 AND family_id=$2 FOR SHARE", [evidence.candidateId,familyId])).rows[0];
    if (!candidate || candidate.content_hash !== skillContentHash(draft) || candidate.base_version !== baseVersion) {
      throw new AppError("AGENT_SKILL_CANDIDATE_STALE", "Содержимое или базовая версия изменились: создай новый черновик и повтори проверки");
    }
    const selection = candidate.selection_evaluation;
    if (!selection || selection.candidate.passed.length < 2 || !selection.candidate.passed.every(Boolean)) {
      throw new AppError("AGENT_SKILL_SELECTION_FAILED", "Сначала test_selection: положительные и отрицательные примеры должны пройти");
    }
    const runs = (await client.query<Run>(
      "SELECT * FROM authored_skill_trial_runs WHERE candidate_id=$1 AND family_id=$2 AND status='checked' ORDER BY created_at DESC", [candidate.id,familyId],
    )).rows;
    const passed = (run: Run) => run.passed.length > 0 && run.passed.every(Boolean);
    const main = runs.find((run) => run.id === evidence.runId && run.variant === "candidate");
    if (!main || !passed(main) || main.request !== trialRequest?.trim()) throw new AppError("AGENT_SKILL_EVAL_FAILED", "Пробный прогон кандидата не прошёл проверки");
    for (const example of examples) {
      const current = runs.find((run) => run.example_id === example.id && run.variant === "candidate");
      const baseline = runs.find((run) => run.example_id === example.id && run.variant === "baseline");
      if (!current || !baseline || !passed(current) || JSON.stringify(current.checks) !== JSON.stringify(baseline.checks)) {
        throw new AppError("AGENT_SKILL_EVAL_MISSING", `Нужны baseline и успешный кандидат с одинаковыми проверками: ${example.id}`);
      }
    }
  },
};
