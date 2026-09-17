import { describe, expect, it } from "vitest";
import { matchToolFixture, scoreScenarioCheck, assertExperimentSkill } from "./skill-scenario.js";
import { experimentProtocolSchema } from "./skill-experiment.js";

describe("authored skill scenario evidence", () => {
  const fixture = { toolName: "send_workspace_file", input: { filePath: "/workspace/a.txt" }, output: { sent: true } };
  it("matches exact inputs only; never invents a result for an uncovered call", () => {
    expect(matchToolFixture([fixture], fixture.toolName, fixture.input)).toEqual(fixture);
    expect(matchToolFixture([fixture], fixture.toolName, { ...fixture.input, recipient: "someone" })).toBeUndefined();
    expect(matchToolFixture([fixture], "web_search", fixture.input)).toBeUndefined();
  });
  it("checks final answers and counts requested actions including forbidden repeats", () => {
    const calls = [{ toolName: fixture.toolName, input: fixture.input }, { toolName: fixture.toolName, input: fixture.input }];
    expect(scoreScenarioCheck({ target: "answer", json: { ok: true } }, '{"ok":true}', calls)).toBe(true);
    expect(scoreScenarioCheck({ target: "answer", text: "done" }, "done extra", calls)).toBe(false);
    expect(scoreScenarioCheck({ target: "tool", toolName: fixture.toolName, count: 1 }, "", calls)).toBe(false);
    expect(scoreScenarioCheck({ target: "tool", toolName: "manage_memory", count: 0 }, "", calls)).toBe(true);
  });
  it("accepts non-file skills only with an explicit scenario contract for every named tool", () => {
    const draft = { name: "send-report", markdown: "## Шаги\nВызови `send_workspace_file`.\n## Проверка результата\nПроверь." };
    const cases = ["development", "holdout"].map((partition) => ({ id: partition, partition, request: "task", files: {}, checks: [{ target: "answer", text: "done" }] }));
    expect(() => assertExperimentSkill(draft, experimentProtocolSchema.parse({ cases }), {})).toThrow();
    expect(() => assertExperimentSkill(draft, experimentProtocolSchema.parse({ environment: "scenario", cases }), { send_workspace_file: { description: "Send", inputSchema: {}, source: "application" } })).not.toThrow();
  });
});
