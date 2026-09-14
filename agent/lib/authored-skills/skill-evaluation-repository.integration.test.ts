import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { database, closeDatabase } from "../database.js";
import { createMainAgentMemoryFixture } from "../memory-agent-write.integration-fixtures.js";
import { skillEvaluationRepository } from "./skill-evaluation-repository.js";
import { authoredSkillRepository } from "./authored-skill-repository.js";
import type { FamilyCaller } from "../family-context.js";

const suite = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
const draft = { name: "report", description: "Отчёт по запросу пользователя", markdown: "## Когда применять\nДля отчёта.\n## Шаги\n1. Вызови `web_search`.\n## Проверка результата\nЕсть источники.", files: {}, changeNote: "Первая версия", trialSummary: "Проверены источники" };
const provenance = { eveSessionId: "test-session", eveTurnId: "test-turn" };
suite("skill trial provenance", () => {
  let caller: FamilyCaller;
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
    const fixture = await createMainAgentMemoryFixture();
    caller = { familyId: fixture.familyId, userId: fixture.userId, role: "owner" };
  });
  afterAll(closeDatabase);
  it("requires observed results, rejects foreign runs and binds the gate to candidate content", async () => {
    const candidate = await skillEvaluationRepository.draft(caller, draft, "draft-1", new Set(["web_search"]));
    const run = await skillEvaluationRepository.begin(caller, {
      candidateId: candidate.id, request: "Тестовый запрос", variant: "candidate", checks: [{ toolName: "web_search", path: ["url"], operator: "nonempty" }],
      ...provenance, operationKey: "begin-1",
    });
    await expect(skillEvaluationRepository.finish(caller, run.id, provenance, "Готово"))
      .rejects.toMatchObject({ code: "AGENT_SKILL_TRIAL_NO_EVIDENCE" });
    await skillEvaluationRepository.observe({ ...provenance, familyId: caller.familyId, eventId: "e1", toolName: "web_search", succeeded: true, output: { url: "https://example.com" } });
    await expect(skillEvaluationRepository.finish(caller, run.id, { ...provenance, eveTurnId: "another" }, "Готово"))
      .rejects.toMatchObject({ code: "AGENT_SKILL_TRIAL_NOT_FOUND" });
    const finished = await skillEvaluationRepository.finish(caller, run.id, provenance, "Есть источник");
    expect(finished.passed).toEqual([true]);
    await database().query("UPDATE authored_skill_candidates SET selection_evaluation=$2::jsonb WHERE id=$1", [candidate.id,
      JSON.stringify({ candidate: { passed: [true, true] }, cases: [{ request: "Отчёт", shouldLoad: true }, { request: "Привет", shouldLoad: false }] })]);
    const client = await database().connect();
    try {
      await expect(skillEvaluationRepository.verify(client, caller.familyId, { candidateId: candidate.id, runId: run.id }, draft, 0, [], "Тестовый запрос"))
        .resolves.toBeUndefined();
      await expect(skillEvaluationRepository.verify(client, caller.familyId, { candidateId: candidate.id, runId: run.id }, { ...draft, markdown: draft.markdown + "другое" }, 0, []))
        .rejects.toMatchObject({ code: "AGENT_SKILL_CANDIDATE_STALE" });
      await expect(skillEvaluationRepository.verify(client, caller.familyId, { candidateId: candidate.id, runId: run.id }, draft, 0, [], "Другой запрос"))
        .rejects.toMatchObject({ code: "AGENT_SKILL_EVAL_FAILED" });
    } finally { client.release(); }
  });
  it("cancels only the current turn's running trial and releases its slot", async () => {
    const candidate = await skillEvaluationRepository.draft(caller, draft, "draft-cancel", new Set(["web_search"]));
    const input = { ...provenance, candidateId: candidate.id, request: "Сводка", variant: "candidate" as const,
      checks: [{ toolName: "web_search", path: [], operator: "succeeded" as const }], operationKey: "begin-cancel" };
    const run = await skillEvaluationRepository.begin(caller, input);
    expect(await skillEvaluationRepository.cancel(caller, run.id, { ...provenance, eveTurnId: "other" })).toEqual({ cancelled: false });
    expect(await skillEvaluationRepository.cancel(caller, run.id, provenance)).toEqual({ cancelled: true });
    await expect(skillEvaluationRepository.finish(caller, run.id, provenance, "Готово"))
      .rejects.toMatchObject({ code: "AGENT_SKILL_TRIAL_CANCELLED" });
    expect((await skillEvaluationRepository.begin(caller, { ...input, operationKey: "begin-next" })).id).not.toBe(run.id);
  });

  it("queues one draft preparation after two distinct owner-confirmed failures", async () => {
    await authoredSkillRepository.publish(caller, draft, { knownToolNames: new Set(["web_search"]), operationKey: "publish", provenance });
    const conversationId = (await database().query("SELECT id FROM application_conversations WHERE family_id=$1 AND scope='personal' LIMIT 1", [caller.familyId])).rows[0].id;
    const packages = await authoredSkillRepository.activePackages(caller.familyId);
    for (const turn of ["one", "two"]) {
      const trace = { ...provenance, eveTurnId: turn };
      await authoredSkillRepository.capturePackages(caller.familyId, trace, packages);
      await authoredSkillRepository.recordUsage({ ...trace, familyId: caller.familyId, conversationId, skillName: draft.name });
      const usage = (await authoredSkillRepository.usages(caller.familyId, draft.name, conversationId))[0];
      await authoredSkillRepository.recordOutcome(caller, { conversationId, usageId: usage.id, name: draft.name, outcome: "failed", note: "Не те источники" });
    }
    const hints = await database().query("SELECT kind,summary FROM conversation_skill_hints WHERE conversation_id=$1", [conversationId]);
    expect(hints.rows).toEqual([{ kind: "improve", summary: "report" }]);
    const usage = (await authoredSkillRepository.usages(caller.familyId, draft.name, conversationId))[0];
    await database().query("DELETE FROM conversation_skill_hints WHERE conversation_id=$1", [conversationId]);
    await authoredSkillRepository.recordOutcome(caller, { conversationId, usageId: usage.id, name: draft.name, outcome: "failed", note: "Уточнение" });
    expect((await database().query("SELECT * FROM conversation_skill_hints WHERE conversation_id=$1", [conversationId])).rows).toHaveLength(0);
  });

  it("keeps exact version, idempotent usage and owner feedback separate from execution failure", async () => {
    await authoredSkillRepository.publish(caller, draft, { knownToolNames: new Set(["web_search"]), operationKey: "pub-1", provenance });
    await authoredSkillRepository.capturePackages(caller.familyId, provenance, await authoredSkillRepository.activePackages(caller.familyId));
    await authoredSkillRepository.publish(caller, { ...draft, description: "Версия два" }, { knownToolNames: new Set(["web_search"]), operationKey: "pub-2", provenance });
    const conversationId = (await database().query("SELECT id FROM application_conversations WHERE family_id=$1 LIMIT 1", [caller.familyId])).rows[0].id;
    const usage = { ...provenance, conversationId, familyId: caller.familyId, skillName: draft.name };
    await authoredSkillRepository.recordUsage(usage);
    await authoredSkillRepository.recordUsage(usage);
    const rows = await authoredSkillRepository.usages(caller.familyId, draft.name, conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(1);
    await authoredSkillRepository.recordOutcome(caller, { conversationId, usageId: rows[0].id, name: draft.name, outcome: "ok", note: "Подтверждено" });
    await authoredSkillRepository.recordTelemetry({ ...provenance, familyId: caller.familyId, name: draft.name, executionStatus: "failed", stepCount: 12, note: "Поздний сбой" });
    expect((await authoredSkillRepository.usages(caller.familyId, draft.name, conversationId))[0]).toMatchObject({ outcome: "ok", outcome_source: "owner", execution_status: "failed" });
    expect(await authoredSkillRepository.recordOutcome(caller, { conversationId: null, usageId: rows[0].id, name: draft.name, outcome: "failed", note: null })).toMatchObject({ usageFound: false });
  });
});
