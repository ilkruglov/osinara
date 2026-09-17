import { expect, it, vi } from "vitest";
import { evaluateSkillRubric } from "./skill-rubric.js";

it("grades frozen criteria independently and rejects incomplete or malformed judgments", async () => {
  const rubric = { target: "rubric" as const, criteria: ["Верное число", "Указан источник"], reference: "42 из входного файла" };
  const generate = vi.fn().mockResolvedValue('{"passed":[true,false]}');
  expect(await evaluateSkillRubric(rubric, { request: "Составь отчёт", answer: "42", calls: [], files: {} }, generate)).toBe(false);
  const prompt = generate.mock.calls[0][0];
  expect(prompt).toContain("42 из входного файла");
  expect(prompt).not.toContain("candidate");
  generate.mockResolvedValue('{"passed":[true]}');
  await expect(evaluateSkillRubric(rubric, { request: "task", answer: "ok", calls: [], files: {} }, generate)).rejects.toThrow();
  generate.mockResolvedValue('{"passed":[true,true]}');
  expect(await evaluateSkillRubric(rubric, { request: "task", answer: "ok", calls: [], files: {} }, generate)).toBe(true);
});
