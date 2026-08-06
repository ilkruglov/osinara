/**
 * Root Eve agent configuration tests.
 *
 * Constructs:
 * - Delegation depth one lets the root use a fresh-context native child.
 * - The delegated copy cannot recursively create another child session.
 */
import { describe, expect, it } from "vitest";
import agent from "../agent.js";
import { resolveSubagentDelegationLimit } from "../../node_modules/eve/dist/src/harness/subagent-depth.js";

describe("root agent configuration", () => {
  it("allows exactly one subagent level", () => {
    expect(agent.limits?.maxSubagentDepth).toBe(1);
    expect(resolveSubagentDelegationLimit({ subagentMaxDepth: 1 })).toEqual({
      currentDepth: 0,
      maxDepth: 1,
      nextChildDepth: 1,
      reached: false,
    });
    expect(resolveSubagentDelegationLimit({ subagentDepth: 1, subagentMaxDepth: 1 })).toEqual({
      currentDepth: 1,
      maxDepth: 1,
      nextChildDepth: 2,
      reached: true,
    });
  });
});
