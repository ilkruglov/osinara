/** No production executor is reachable: only exact frozen fixtures and workspace writes. */
import type { ToolContext } from "eve/tools";
import { matchToolFixture } from "../../../../agent/lib/authored-skills/skill-scenario.js";
import { job, journal } from "./job.js";

let attempts = 0;
export async function simulateTool(name: string, input: unknown, ctx: ToolContext): Promise<unknown> {
  if (++attempts > 32) { journal({ kind: "uncovered", reason: "tool_budget" }); throw new Error("AGENT_SKILL_LAB_TOOL_LIMIT"); }
  const fixture = matchToolFixture(job().testCase.toolFixtures ?? [], name, input);
  if (!fixture) {
    journal({ kind: "uncovered", toolName: name });
    throw new Error("AGENT_SKILL_LAB_SCENARIO_UNCOVERED: для этих аргументов нет тестового ответа");
  }
  journal({ kind: "simulated", toolName: name });
  if (fixture.files) {
    const sandbox = await ctx.getSandbox();
    for (const [path, content] of Object.entries(fixture.files)) await sandbox.writeTextFile({ path, content });
  }
  if (fixture.isError) throw new Error(JSON.stringify(fixture.output));
  return fixture.output;
}
