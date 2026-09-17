import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { database, closeDatabase } from "../database.js";
import { createMainAgentMemoryFixture } from "../memory-agent-write.integration-fixtures.js";
import { skillEvaluationRepository } from "./skill-evaluation-repository.js";
import { skillExperimentRepository as repo } from "./skill-experiment-repository.js";
import type { FamilyCaller } from "../family-context.js";
import { verifySkillExperiment } from "./skill-experiment-publication.js";

const suite = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
const draft = { name: "file-report", description: "Отчёт из файла", markdown: "## Когда применять\nДля отчёта.\n## Шаги\n1. Вызови `read_file`, затем `write_file`.\n## Проверка результата\nПроверь результат.", files: {}, changeNote: "Первая версия", trialSummary: "Пока не проверено" };
const protocol = { cases: ["development", "holdout"].map((partition) => ({ id: partition, partition, request: `Задача ${partition}`, files: {}, checks: [{ path: "/workspace/result.txt", text: "42" }] })) };
suite("skill experiment ledger", () => {
  let caller: FamilyCaller;
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
    const f = await createMainAgentMemoryFixture();
    caller = { familyId: f.familyId, userId: f.userId, role: "owner" };
  });
  afterAll(closeDatabase);
  it("rejects built-in packages, invented tools and private-only descriptors in family chat", async () => {
    await expect(repo.create(caller, "docx", protocol, "built-in")).rejects.toMatchObject({ code: "AGENT_SKILL_EXPERIMENT_UNSUPPORTED" });
    for (const toolName of ["invented_tool", "export_memory"]) {
      const scenario = { environment: "scenario", cases: protocol.cases.map((c) => ({ ...c, toolFixtures: [{ toolName, input: {}, output: {} }] })) };
      await expect(repo.create(caller, draft.name, scenario, toolName, "family")).rejects.toMatchObject({ code: "AGENT_SKILL_EXPERIMENT_UNSUPPORTED" });
    }
    const generic = { environment: "scenario", cases: protocol.cases.map((c) => ({ ...c, toolFixtures: [{ toolName: "agent", input: { task: "report" }, output: "result" }] })) };
    const e = await repo.create(caller, draft.name, generic, "generic");
    expect(await repo.status(caller, e.id)).toMatchObject({ genericScenarioTools: ["agent"] });
  });
  it("freezes scenario descriptors and labels evidence without granting real capabilities", async () => {
    const scenario = { ...protocol, environment: "scenario", cases: protocol.cases.map((c) => ({ ...c,
      toolFixtures: [{ toolName: "web_fetch", input: { url: "https://example.com" }, output: "Test page" }],
    })) };
    const experiment = await repo.create(caller, draft.name, scenario, "scenario");
    const content = { ...draft, markdown: draft.markdown.replace("`read_file`", "`web_fetch`") };
    const candidate = await skillEvaluationRepository.draft(caller, content, "new", new Set());
    await repo.enroll(caller, experiment.id, candidate.id);
    const batch = (await repo.start(caller, experiment.id))!;
    expect(batch.experiment.tool_contracts.web_fetch.source).toBe("application");
    expect(batch.experiment.tool_contracts.web_fetch).not.toHaveProperty("execute");
    expect(await repo.status(caller, experiment.id)).toMatchObject({ evidenceScope: "simulated_tools", qualityAssessment: "deterministic_checks" });
    for (const run of batch.runs) {
      await repo.reserveRun(caller, experiment.id, run.id);
      await repo.completeRun(experiment.id, run.id, { status: "completed", passed: [true], artifactHashes: {}, telemetry: {} });
    }
    await repo.finish(experiment.id);
    const c = await database().connect();
    const verify = () => verifySkillExperiment(c, caller.familyId, experiment.id, candidate.id, content, 0, [], "Задача development");
    try {
      await expect(verify()).rejects.toThrow();
      await c.query("UPDATE authored_skill_experiment_runs SET telemetry=$2 WHERE experiment_id=$1", [experiment.id,
        JSON.stringify({ evidenceScope: "simulated_tools", toolContractsHash: batch.experiment.tool_contracts_hash, coverageComplete: true })]);
      await expect(verify()).resolves.toBeUndefined();
      await c.query("UPDATE authored_skill_experiments SET tool_contracts='{}' WHERE id=$1", [experiment.id]);
      await expect(verify()).rejects.toThrow();
    } finally { c.release(); }
  });
  it("freezes the protocol before drafts, binds candidates, and never starts a batch twice", async () => {
    const old = await skillEvaluationRepository.draft(caller, draft, "old", new Set());
    const experiment = await repo.create(caller, draft.name, protocol, "create");
    await expect(repo.enroll(caller, experiment.id, old.id)).rejects.toThrow(/протокола/u);
    const candidate = await skillEvaluationRepository.draft(caller, draft, "new", new Set());
    await repo.enroll(caller, experiment.id, candidate.id);
    await repo.enroll(caller, experiment.id, candidate.id);
    const started = await repo.start(caller, experiment.id);
    expect(started?.runs).toHaveLength(8);
    expect(started?.candidates[0].content_hash).toBe(candidate.content_hash);
    expect(await repo.start(caller, experiment.id)).toBeNull();
    await expect(repo.enroll(caller, experiment.id, candidate.id)).rejects.toThrow();
    const status = await repo.status(caller, experiment.id);
    expect(JSON.stringify(status)).not.toContain("Задача holdout");
    expect(status.status).toBe("running");
  });
  it("rechecks owner role, rejects foreign parents and terminates cancellation without replay", async () => {
    const experiment = await repo.create(caller, draft.name, protocol, "create");
    const candidate = await skillEvaluationRepository.draft(caller, draft, "new", new Set());
    await expect(repo.enroll(caller, experiment.id, candidate.id, candidate.id)).rejects.toThrow();
    await repo.enroll(caller, experiment.id, candidate.id);
    await repo.start(caller, experiment.id);
    await repo.cancel(caller, experiment.id);
    expect(await repo.start(caller, experiment.id)).toBeNull();
    expect(await repo.isRunning(caller, experiment.id)).toBe(false);
    await database().query("UPDATE family_memberships SET role='member' WHERE family_id=$1 AND user_id=$2", [caller.familyId, caller.userId]);
    await expect(repo.status(caller, experiment.id)).rejects.toMatchObject({ code: "AGENT_SKILL_FORBIDDEN" });
  });
  it("publication rejects incomplete pairs, failed holdout and changed content", async () => {
    const experiment = await repo.create(caller, draft.name, protocol, "create");
    const candidate = await skillEvaluationRepository.draft(caller, draft, "new", new Set());
    await repo.enroll(caller, experiment.id, candidate.id);
    const batch = (await repo.start(caller, experiment.id))!;
    const c = await database().connect();
    const verify = (content = draft) => verifySkillExperiment(c, caller.familyId, experiment.id, candidate.id, content, 0, [], "Задача development");
    try {
      await expect(verify()).rejects.toMatchObject({ code: "AGENT_SKILL_EXPERIMENT_EVIDENCE" });
      for (const run of batch.runs) {
        expect(await repo.reserveRun(caller, experiment.id, run.id)).toBe(true);
        await repo.completeRun(experiment.id, run.id, { status: "completed", passed: [run.variant !== "baseline"], telemetry: {}, artifactHashes: {} });
      }
      await repo.finish(experiment.id);
      await expect(verify()).resolves.toBeUndefined();
      await expect(verify({ ...draft, markdown: draft.markdown + "other" })).rejects.toThrow();
      await database().query("UPDATE authored_skill_experiment_runs SET passed='[false]' WHERE experiment_id=$1 AND variant=$2 AND partition='holdout'", [experiment.id,candidate.id]);
      await expect(verify()).rejects.toThrow();
    } finally { c.release(); }
  });
});
