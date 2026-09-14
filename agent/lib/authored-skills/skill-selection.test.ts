import { describe, expect, it } from "vitest";
import { evaluateSkillSelection } from "./skill-selection.js";

describe("skill selection", () => {
  const cases = [{ request: "Сделай сводку", shouldLoad: true }, { request: "Привет", shouldLoad: false }];
  it("tests descriptions in fresh context and compares selected names with positive and negative expectations", async () => {
    let observed = "";
    const result = await evaluateSkillSelection("report", [{ name: "report", description: "Сводка новостей" }], cases, async (prompt) => {
      observed = prompt;
      return '["report",null]';
    });
    expect(result.passed).toEqual([true, true]);
    expect(observed).toContain("Сводка новостей");
    expect(observed).not.toContain("shouldLoad");
  });
  it("fails closed on invented selections or malformed output", async () => {
    expect((await evaluateSkillSelection("report", [{ name: "report", description: "Сводка" }], cases, async () => '["unknown","report"]')).passed).toEqual([false,false]);
    await expect(evaluateSkillSelection("report", [], cases, async () => "готово")).rejects.toThrow();
  });
});
