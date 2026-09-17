/** Dynamic overrides replace even disabled native tools, never importing real executors. */
import { defineDynamic, defineTool, type ToolDefinition } from "eve/tools";
import { loadSkill } from "eve/tools/defaults";
import { job } from "../lib/job.js";
import { simulateTool } from "../lib/scenario.js";
import { labToolRuntimeName } from "../../../../agent/lib/authored-skills/skill-lab-model.js";

export default defineDynamic({ events: { "session.started": () =>
  Object.fromEntries(Object.entries(job().toolContracts ?? {}).map(([name, contract]) => [labToolRuntimeName(name), defineTool<Record<string, unknown>, unknown>({
    description: contract.description,
    inputSchema: contract.inputSchema as ToolDefinition<Record<string, unknown>>["inputSchema"],
    async execute(input, ctx) {
      if (name === "load_skill" && job().skill && input.skill === job().skill!.name) return loadSkill.execute(input, ctx);
      return simulateTool(name, input, ctx);
    },
  })])),
} });
