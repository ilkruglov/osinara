/**
 * Root Eve agent configuration tests.
 *
 * Constructs:
 * - Delegation depth one lets the root orchestrate fresh-context workers.
 * - A delegated worker cannot recursively create another child session.
 * - The declared worker has an explicit specialist identity and root-equivalent model capacity.
 */
import { describe, expect, it } from "vitest";
import { isDisabledToolSentinel } from "eve/tools";

import agent from "../agent.js";
import taskWorker from "../subagents/task_worker/agent.js";
import workerGenericAgent from "../subagents/task_worker/tools/agent.js";
import workerWebFetch from "../subagents/task_worker/tools/web_fetch.js";
import rootGenericAgent from "../tools/agent.js";
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

  it("declares the universal task worker as a bounded specialist", () => {
    expect(taskWorker.description).toMatch(/больш|задач|материал/iu);
    expect(taskWorker.model).toBe(agent.model);
    expect(taskWorker.modelContextWindowTokens).toBe(agent.modelContextWindowTokens);
  });

  it("replaces generic delegation with an executable denial at both agent levels", async () => {
    for (const tool of [rootGenericAgent, workerGenericAgent]) {
      await expect(tool.execute({ message: "unsafe copy" }, {} as never)).rejects.toThrowError(
        /AGENT_GENERIC_SUBAGENT_FORBIDDEN/u,
      );
    }
  });

  it("keeps worker HTTP access disabled even for public destinations", () => {
    expect(isDisabledToolSentinel(workerWebFetch)).toBe(true);
  });
});
