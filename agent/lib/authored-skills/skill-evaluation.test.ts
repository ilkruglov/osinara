import { describe, expect, it } from "vitest";
import { evaluateTrial, skillContentHash } from "./skill-evaluation.js";

describe("skill evaluation evidence", () => {
  it("cannot pass with a summary or a missing result", () => {
    expect(evaluateTrial([{ toolName: "web_search", path: ["results", "0", "url"], operator: "nonempty" }], [])).toEqual([false]);
  });
  it("checks actual output and rejects failed actions and missing fields", () => {
    const checks = [{ toolName: "web_search", path: ["results", "0", "url"], operator: "nonempty" as const }];
    expect(evaluateTrial(checks, [{ toolName: "web_search", succeeded: true, output: { results: [{ url: "https://example.com" }] } }])).toEqual([true]);
    expect(evaluateTrial(checks, [{ toolName: "web_search", succeeded: false, output: { results: [{ url: "https://example.com" }] } }])).toEqual([false]);
    expect(evaluateTrial(checks, [{ toolName: "web_search", succeeded: true, output: {} }])).toEqual([false]);
  });
  it("checks expected values rather than JS truthiness", () => {
    expect(evaluateTrial([{ toolName: "check", path: ["ok"], operator: "equals", expected: true }], [
      { toolName: "check", succeeded: true, output: { ok: "true" } },
    ])).toEqual([false]);
  });
  it("binds results to the exact candidate, including reference files", () => {
    const content = { name: "report", description: "Report", markdown: "Steps", files: { "references/a.md": "a", "references/b.md": "b" } };
    expect(skillContentHash(content)).toBe(skillContentHash({ ...content, files: { "references/b.md": "b", "references/a.md": "a" } }));
    expect(skillContentHash(content)).not.toBe(skillContentHash({ ...content, markdown: "Other steps" }));
  });
});
