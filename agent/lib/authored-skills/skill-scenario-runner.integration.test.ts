/** Native Eve scenario execution; the HTTP model is deterministic, external actions are fixtures. */
import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runSkillLab } from "./skill-lab-runner.js";
import type { LabJob } from "../../../services/skill-lab/agent/lib/job.js";

const suite = process.env.RUN_SKILL_LAB_TESTS === "true" ? describe : describe.skip;
suite("authored scenario laboratory", () => {
  it("runs a search/send skill without external executors, scores answers and actions, budgets an independent judge", async () => {
    vi.stubEnv("MODEL_API_KEY", "skill-lab-test-key");
    const bodies: any[] = [];
    let wrongInput = false;
    let malformedJudge = false;
    let searchTool = "web_search";
    let skipMainSkill = false;
    // oxlint-disable-next-line typescript/no-misused-promises -- a test server; a failure surfaces through the assertions
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      bodies.push(body);
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "judge", model: "lab", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: malformedJudge ? "invalid" : '{"passed":[true]}' } }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }));
        return;
      }
      const called = body.messages.flatMap((m: any) => m.tool_calls?.map((c: any) => ({ name: c.function.name, input: JSON.parse(c.function.arguments) })) ?? []);
      let call: { name: string; arguments: string } | undefined;
      if (!skipMainSkill && !called.some((c: any) => c.name === "load_skill" && c.input.skill === "search-report")) call = { name: "load_skill", arguments: '{"skill":"search-report"}' };
      else if (!called.some((c: any) => c.name === "load_skill" && c.input.skill === "helper")) call = { name: "load_skill", arguments: '{"skill":"helper"}' };
      else if (!called.some((c: any) => c.name === searchTool)) call = { name: searchTool, arguments: JSON.stringify({ query: wrongInput ? "uncovered" : "rate" }) };
      else if (!called.some((c: any) => c.name === "send_workspace_file")) call = { name: "send_workspace_file", arguments: '{"filePath":"/workspace/report.txt"}' };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (delta: unknown, finish: string | null) => res.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "lab", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      emit(call ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${called.length}`, type: "function", function: call }] } : { role: "assistant", content: "Итог: 42" }, null);
      emit({}, call ? "tool_calls" : "stop");
      res.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "lab", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const contract = (field: string) => ({ description: "Test action", inputSchema: { type: "object", properties: { [field]: { type: "string" } }, required: [field], additionalProperties: false }, source: "application" as const });
    const job: LabJob = {
      runId: "scenario-run", maxCalls: 8, environment: "scenario",
      toolContracts: { load_skill: contract("skill"), web_search: contract("query"), send_workspace_file: contract("filePath") },
      skill: { name: "search-report", description: "Report", markdown: "CANDIDATE_PRIVATE_INSTRUCTIONS", files: {}, changeNote: "test", trialSummary: "test" },
      testCase: { id: "one", partition: "holdout", request: "Найди курс и отправь отчёт", files: {},
        toolFixtures: [
          { toolName: "load_skill", input: { skill: "helper" }, output: "Тестовая инструкция помощника" },
          { toolName: "web_search", input: { query: "rate" }, output: { rate: 42 }, files: { "/workspace/report.txt": "42" } },
          { toolName: "send_workspace_file", input: { filePath: "/workspace/report.txt" }, output: { sent: true } },
        ],
        checks: [{ target: "answer", text: "Итог: 42" }, { target: "tool", toolName: "send_workspace_file", count: 1 },
          { path: "/workspace/report.txt", text: "42" }, { target: "rubric", criteria: ["Верное число"], reference: "RUBRIC_SECRET: правильное число 42" }],
      },
      model: { transport: { protocol: "openai-chat-completions", baseUrl: `http://127.0.0.1:${port}/v1`, providerName: "test", reasoning: null },
        models: { primary: { id: "lab", maxOutputTokens: 2048, contextWindowTokens: 100_000 }, vision: { supportsImageInput: false } } },
    };
    try {
      const result = await runSkillLab(job, AbortSignal.timeout(45_000), { diagnostic: console.error });
      expect(result).toMatchObject({ status: "completed", passed: [true, true, true, true], telemetry: { calls: 6, judgeCalls: 1, simulatedCalls: 3, coverageComplete: true, evidenceScope: "simulated_tools", loaded: true } });
      expect(JSON.stringify(bodies.filter((b) => b.stream))).not.toContain("RUBRIC_SECRET");
      expect(JSON.stringify(bodies.filter((b) => !b.stream))).not.toContain("CANDIDATE_PRIVATE_INSTRUCTIONS");
      expect(bodies.filter((b) => !b.stream).every((b) => !b.tools?.length)).toBe(true);
      expect(result.artifactHashes.answer).toMatch(/^[a-f0-9]{64}$/u);
      skipMainSkill = true;
      const impostor: LabJob = { ...job, testCase: { ...job.testCase, toolFixtures: job.testCase.toolFixtures!.map((f) =>
        f.toolName === "load_skill" ? { ...f, output: job.skill!.markdown } : f) } };
      expect(await runSkillLab(impostor, AbortSignal.timeout(45_000))).toMatchObject({ status: "completed", passed: [false, false, false, false], telemetry: { loaded: false } });
      skipMainSkill = false;
      wrongInput = true;
      expect(await runSkillLab(job, AbortSignal.timeout(45_000))).toMatchObject({ status: "interrupted", telemetry: { coverageComplete: false, diagnostic: "scenario_uncovered" } });
      wrongInput = false;
      malformedJudge = true;
      expect(await runSkillLab(job, AbortSignal.timeout(45_000))).toMatchObject({ status: "interrupted", passed: [], telemetry: { judgeCalls: 1 } });
      malformedJudge = false;
      expect(await runSkillLab({ ...job, maxCalls: 5 }, AbortSignal.timeout(45_000))).toMatchObject({ status: "interrupted", passed: [], telemetry: { calls: 5, judgeCalls: 0 } });
      for (const name of ["bash", "agent", "ask_question"]) {
        searchTool = name;
        const { web_search: _search, ...other } = job.toolContracts!;
        const special: LabJob = { ...job, toolContracts: { ...other, [name]: contract("query") }, testCase: { ...job.testCase,
          checks: job.testCase.checks.slice(0, 3),
          toolFixtures: job.testCase.toolFixtures!.map((f) => f.toolName === "web_search" ? { ...f, toolName: name } : f),
        } };
        expect(await runSkillLab(special, AbortSignal.timeout(45_000)), name).toMatchObject({ status: "completed", passed: [true, true, true], telemetry: { simulatedCalls: 3 } });
      }
    } finally { vi.unstubAllEnvs(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
  }, 100_000);
});
