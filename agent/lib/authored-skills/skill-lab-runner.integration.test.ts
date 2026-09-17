/** Real Eve build, sandbox and tools; only the HTTP model provider is deterministic. */
import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runSkillLab } from "./skill-lab-runner.js";
import type { LabJob } from "../../../services/skill-lab/agent/lib/job.js";
const suite = process.env.RUN_SKILL_LAB_TESTS === "true" ? describe : describe.skip;
suite("native isolated skill laboratory", () => {
  it("executes the exact skill through load_skill, isolates fixtures, and checks real file artifacts", async () => {
    vi.stubEnv("MODEL_API_KEY", "skill-lab-test-key");
    let reportStalled!: () => void;
    const stalledRequest = new Promise<void>((done) => { reportStalled = done; });
    const requests: { tools: { function: { name: string } }[]; messages: { role: string; content: string; tool_calls?: unknown[] }[] }[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      if (body.messages.some((m: { role: string; content: string }) => m.role === "user" && m.content === "STALL")) {
        reportStalled();
        return;
      }
      const messages = body.messages as { role: string; content: string; tool_calls?: { function: { name: string } }[] }[];
      const called = messages.flatMap((m) => m.tool_calls?.map((c) => c.function.name) ?? []);
      const candidate = messages.some((m) => m.role === "tool" && m.content.includes("CANDIDATE_EXACT"));
      let call: { name: string; arguments: string } | undefined;
      if (!called.includes("load_skill")) call = { name: "load_skill", arguments: JSON.stringify({ skill: "file-report" }) };
      else if (!called.includes("read_file")) call = { name: "read_file", arguments: JSON.stringify({ filePath: "/workspace/input.txt" }) };
      else if (!called.includes("write_file")) call = { name: "write_file", arguments: JSON.stringify({ filePath: "/workspace/result.txt", content: candidate ? "42" : "wrong" }) };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (delta: unknown, finish: string | null) => res.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "lab", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      emit(call ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${called.length}`, type: "function", function: call }] } : { role: "assistant", content: "Готово" }, null);
      emit({}, call ? "tool_calls" : "stop");
      res.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "lab", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    try {
      const job: LabJob = {
        runId: "test-run", maxCalls: 6,
        skill: { name: "file-report", description: "File report", markdown: "CANDIDATE_EXACT", files: {}, changeNote: "test", trialSummary: "test" },
        testCase: { id: "one", partition: "development", request: "Прочитай input.txt и запиши result.txt в /workspace", files: { "/workspace/input.txt": "input" }, checks: [{ path: "/workspace/result.txt", text: "42" }] },
        model: { transport: { protocol: "openai-chat-completions", baseUrl: `http://127.0.0.1:${port}/v1`, providerName: "test", reasoning: null },
          models: { primary: { id: "lab", maxOutputTokens: 2048, contextWindowTokens: 100_000 }, vision: { supportsImageInput: false } } },
      };
      const candidate = await runSkillLab(job, AbortSignal.timeout(45_000), { diagnostic: console.error });
      expect(candidate).toMatchObject({ status: "completed", passed: [true], telemetry: { loaded: true, calls: 4 } });
      const baseline = await runSkillLab({ ...job, skill: { ...job.skill!, markdown: "BASELINE_EXACT" } }, AbortSignal.timeout(45_000));
      expect(baseline).toMatchObject({ status: "completed", passed: [false] });
      expect(baseline.telemetry.sessionId).not.toBe(candidate.telemetry.sessionId);
      expect(requests.every((r) => r.tools.every((t) => ["read_file", "write_file", "load_skill"].includes(t.function.name)))).toBe(true);
      expect(JSON.stringify(requests)).not.toContain('"checks"');
      const exhausted = await runSkillLab({ ...job, maxCalls: 2 }, AbortSignal.timeout(45_000));
      expect(exhausted).toMatchObject({ status: "interrupted", passed: [], telemetry: { calls: 2 } });
      const abort = new AbortController();
      const stalled = runSkillLab({ ...job, testCase: { ...job.testCase, request: "STALL" } }, abort.signal);
      try {
        await Promise.race([stalledRequest, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("provider not reached")), 10_000); timer.unref(); })]);
        abort.abort();
        expect(await stalled).toMatchObject({ status: "interrupted", passed: [], telemetry: { calls: 1, diagnostic: "cancelled_or_timed_out" } });
      } finally { abort.abort(); await stalled; }
    } finally { vi.unstubAllEnvs(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
  }, 100_000);
});
