import { describe, expect, it } from "vitest";
import { experimentApprovalSummary, experimentHash, experimentProtocolSchema, scoreArtifact, planExperiment, publicExperimentResults } from "./skill-experiment.js";

const cases = [
  { id: "known", partition: "development", request: "Составь отчёт", files: { "/workspace/input.txt": "42" }, checks: [{ path: "/workspace/result.json", json: { total: 42 } }] },
  { id: "unseen", partition: "holdout", request: "Составь другой отчёт", files: {}, checks: [{ path: "/workspace/result.txt", text: "секретный ответ" }] },
];
describe("isolated skill experiment protocol", () => {
  it("keeps approval within Telegram limits and hashes JSONB independently of key order", () => {
    expect(experimentHash({ a: 1, b: { c: 2, d: 3 } })).toBe(experimentHash({ b: { d: 3, c: 2 }, a: 1 }));
    const summary = experimentApprovalSummary({ cases }).join("\n");
    expect(summary).toContain("300 с");
    expect(summary).toContain("96 вызовов");
    expect(summary.length).toBeLessThan(3500);
  });
  it("requires independent partitions, exact artifact assertions and canonical workspace paths", () => {
    expect(experimentProtocolSchema.safeParse({ cases }).success).toBe(true);
    for (const path of ["/etc/passwd", "/workspace/../secret", "/workspace/a//b", "/workspace/.hidden", "relative"]) {
      expect(experimentProtocolSchema.safeParse({ cases: [{ ...cases[0], files: { [path]: "x" } }, cases[1]] }).success).toBe(false);
    }
    expect(experimentProtocolSchema.safeParse({ cases: [cases[0], { ...cases[0], id: "second" }] }).success).toBe(false);
    expect(experimentProtocolSchema.safeParse({ cases: [cases[0], { ...cases[1], id: "known" }] }).success).toBe(false);
  });
  it("compares structured artifacts without accepting missing files or partial matches", () => {
    expect(scoreArtifact({ path: "/workspace/a", json: { a: 1, b: 2 } }, '{"b":2,"a":1}')).toBe(true);
    expect(scoreArtifact({ path: "/workspace/a", json: { a: 1 } }, '{"a":1,"extra":2}')).toBe(false);
    expect(scoreArtifact({ path: "/workspace/a", text: "done" }, undefined)).toBe(false);
  });
  it("pairs every candidate with baseline on every case twice, reversing order", () => {
    const plan = planExperiment(experimentProtocolSchema.parse({ cases }), ["c1", "c2"]);
    expect(plan).toHaveLength(12);
    expect(plan.filter((run) => run.variant === "baseline")).toHaveLength(4);
    expect(plan.slice(0, 3).map((run) => run.variant)).toEqual(["baseline", "c1", "c2"]);
    expect(plan.slice(3, 6).map((run) => run.variant)).toEqual(["c2", "c1", "baseline"]);
  });
  it("does not disclose holdout cases, expectations or outputs; unknown is not success", () => {
    const result = publicExperimentResults([{ variant: "c1", partition: "holdout", status: "interrupted", passed: [], output: "secret" }]);
    expect(result).toEqual([{ variant: "c1", partition: "holdout", completed: 0, passed: 0, unknown: 1 }]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("accepts answer and rubric checks without requiring an output file", () => {
    const protocol = { cases: cases.map((c) => ({ ...c, checks: [
      { target: "answer", text: "42" },
      { target: "rubric", criteria: ["Ответ объясняет источник числа"], reference: "Число из входного файла" },
    ] })) };
    expect(experimentProtocolSchema.safeParse(protocol).success).toBe(true);
    expect(experimentProtocolSchema.safeParse({ cases: cases.map((c) => ({ ...c, checks: [{ target: "rubric", criteria: [] }] })) }).success).toBe(false);
  });
  it("freezes simulated tool inputs, outputs and call-count assertions explicitly", () => {
    const scenario = { ...cases[0], toolFixtures: [{ toolName: "web_search", input: { query: "test" }, output: { results: [] } }],
      checks: [{ target: "tool", toolName: "web_search", input: { query: "test" }, count: 1 }] };
    expect(experimentProtocolSchema.safeParse({ environment: "scenario", cases: [scenario, cases[1]] }).success).toBe(true);
    expect(experimentProtocolSchema.safeParse({ cases: [scenario, cases[1]] }).success).toBe(false);
    expect(experimentProtocolSchema.safeParse({ environment: "scenario", cases: [{ ...scenario, toolFixtures: [scenario.toolFixtures[0], scenario.toolFixtures[0]] }, cases[1]] }).success).toBe(false);
    expect(experimentApprovalSummary({ environment: "scenario", cases: [scenario, cases[1]] }).join("\n")).toContain("Симуляция");
  });
  it("keeps six large scenario summaries inside Telegram's approval budget", () => {
    const full = { environment: "scenario", cases: Array.from({ length: 6 }, (_, i) => ({
      id: "case-" + "x".repeat(30) + i, partition: i ? "holdout" : "development", request: "д".repeat(2000),
      files: { ["/workspace/" + "x".repeat(160)]: "data" },
      checks: [{ target: "rubric", criteria: ["к".repeat(400)], reference: "о".repeat(300) }],
      toolFixtures: [{ toolName: "a".repeat(90), input: { value: "input" }, output: "response" }],
    })) };
    expect(experimentProtocolSchema.safeParse(full).success).toBe(true);
    expect(experimentApprovalSummary(full).join("\n").length).toBeLessThan(3500);
  });
});
