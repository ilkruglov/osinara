/** Deterministic authored-context budget guarding model prefill latency. */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { manageMemoryPresentation } from "../tools/manage_memory.js";
import { EXTERNAL_GROUP_TOOL_NAMES } from "../tool-policy/group-tool-catalog.js";
import { modeInstructions } from "./mode-instructions.js";

// The mode block is re-sent on every model step: rules that only matter when a specific tool is
// called belong in that tool's descriptor or skill, not here.
// Raised by 300 on 5 September 2026 for the owner's rule on mild, self-invented swearing.
const CORE_CHARACTER_BUDGET = 11_300;
const PRIVATE_CHARACTER_BUDGET = 12_000;
// Raised by 400 on 5 September 2026 for the memory selection criterion and slot guidance, then by
// 300 on 6 September for the addressing section with the explicit silence directive, then by
// 300 the same day for the pending-messages rule in that section.
const FAMILY_CHARACTER_BUDGET = 14_000;
// Raised by 400 on 6 September 2026 for the addressing section with the explicit silence directive,
// then by 2 200 on 7 September for the participants section ported from upstream v0.21.2: opinions
// about behaviour on request, comparisons by a stated criterion, no diagnoses, no template refusal.
const EXTERNAL_CHARACTER_BUDGET = 12_900;
// Raised by 400 on 5 September 2026 for the memory policy: the used-memory directive and the
// selection criterion with the discussion-summary slot, then by 400 on 6 September for the
// addressing section with the explicit silence directive, then by 2 200 on 7 September for the
// participants section ported from upstream v0.21.2.
const EXTERNAL_WORST_CASE_CHARACTER_BUDGET = 22_300;
// Raised by 300 on 5 September 2026 for the two analyst skill lines in the external grant block,
// then by 600 the same day for the memory policy (used-memory directive, selection criterion),
// then by 300 for the owner's rule on mild, self-invented swearing in the core, then by 300 on
// 6 September for the addressing section with the explicit silence directive, then by 2 200 on
// 7 September for the participants section ported from upstream v0.21.2.
const AUTHORED_TOTAL_CHARACTER_BUDGET = 33_500;

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
    const { description } = manageMemoryPresentation(["edit"]);

    expect(description).toContain('"content":"Полная новая версия"');
    expect(description).not.toContain('"kind":"preference"');
    expect(description).not.toContain('"sensitivity":"normal"');
    expect(description).toContain("только при явном изменении классификации");
    // Mutation integrity guidance travels with the tool instead of every model step.
    expect(description).toContain("Сначала прочитай точную активную запись");
  });
});
