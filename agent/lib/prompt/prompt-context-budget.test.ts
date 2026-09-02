/** Deterministic authored-context budget guarding model prefill latency. */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { EXTERNAL_GROUP_TOOL_NAMES } from "../tool-policy/group-tool-catalog.js";
import { memoryEditContract } from "./common-fragments.js";
import { modeInstructions } from "./mode-instructions.js";

const CORE_CHARACTER_BUDGET = 9_000;
const PRIVATE_CHARACTER_BUDGET = 17_000;
const FAMILY_CHARACTER_BUDGET = 18_000;
const EXTERNAL_CHARACTER_BUDGET = 11_000;
const EXTERNAL_WORST_CASE_CHARACTER_BUDGET = 22_000;
const AUTHORED_TOTAL_CHARACTER_BUDGET = 29_000;

describe("authored prompt context budget", () => {
  it("keeps stable and mode-scoped instructions bounded", async () => {
    const core = await readFile("agent/instructions.md", "utf8");
    const privateMode = modeInstructions({ environment: "private" });
    const familyMode = modeInstructions({ environment: "family" });
    const externalMode = modeInstructions({
      capabilities: new Set(),
      environment: "external",
    });
    const allExternalCapabilities = new Set(EXTERNAL_GROUP_TOOL_NAMES);
    const externalWorstCases = [
      modeInstructions({
        capabilities: allExternalCapabilities,
        environment: "external",
        includeApplicationCore: true,
      }),
      modeInstructions({
        capabilities: allExternalCapabilities,
        environment: "external",
        includeApplicationCore: true,
        scheduledHistory: true,
      }),
      modeInstructions({
        capabilities: allExternalCapabilities,
        environment: "external",
        includeApplicationCore: true,
        scheduledHistory: true,
        scheduledRun: true,
      }),
    ];

    expect(core.length).toBeLessThanOrEqual(CORE_CHARACTER_BUDGET);
    expect(privateMode.length).toBeLessThanOrEqual(PRIVATE_CHARACTER_BUDGET);
    expect(familyMode.length).toBeLessThanOrEqual(FAMILY_CHARACTER_BUDGET);
    expect(externalMode.length).toBeLessThanOrEqual(EXTERNAL_CHARACTER_BUDGET);
    for (const mode of externalWorstCases) {
      expect(mode.length).toBeLessThanOrEqual(EXTERNAL_WORST_CASE_CHARACTER_BUDGET);
    }
    for (const mode of [privateMode, familyMode, externalMode, ...externalWorstCases]) {
      expect(core.length + mode.length).toBeLessThanOrEqual(AUTHORED_TOTAL_CHARACTER_BUDGET);
    }
  });

  it("does not ask ordinary memory edits to overwrite classification", () => {
    const contract = memoryEditContract(new Set(["edit"]));

    expect(contract).toContain('"content":"Полная новая версия"');
    expect(contract).not.toContain('"kind":"preference"');
    expect(contract).not.toContain('"sensitivity":"normal"');
    expect(contract).toContain("только при явном изменении классификации");
  });
});
