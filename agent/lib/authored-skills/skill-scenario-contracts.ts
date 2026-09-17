/** Snapshot public descriptors only. Production executors and credentials never enter the lab. */
import { asSchema } from "ai";
import * as defaults from "eve/tools/defaults";
import type { ToolDefinition } from "eve/tools";
import { AppError } from "../app-error.js";
import { EVE_BUILTIN_TOOL_NAMES } from "./authored-skill-contract.js";
import type { ExperimentProtocol } from "./skill-experiment.js";
import type { ScenarioToolContracts } from "./skill-scenario.js";

export async function captureScenarioContracts(protocol: ExperimentProtocol, chatKind: "private" | "family"): Promise<ScenarioToolContracts> {
  if (protocol.environment !== "scenario") return {};
  const catalog = await import("../tool-policy/trusted-mode-tool-catalog.js");
  const application = { ...catalog.TRUSTED_MODE_TOOLS, ...(chatKind === "private" ? catalog.PRIVATE_ONLY_TOOLS : catalog.FAMILY_ONLY_TOOLS) };
  const native: Record<string, ToolDefinition> = { bash: defaults.bash, glob: defaults.glob, grep: defaults.grep,
    todo: defaults.todo, web_fetch: defaults.webFetch, load_skill: defaults.loadSkill, read_file: defaults.readFile, write_file: defaults.writeFile };
  const names = new Set(protocol.cases.flatMap((c) => [
    ...(c.toolFixtures ?? []).map((f) => f.toolName),
    ...c.checks.flatMap((v) => "target" in v && v.target === "tool" ? [v.toolName] : []),
  ]));
  const result: ScenarioToolContracts = {};
  for (const name of names) {
    if (!Object.hasOwn(application, name) && !EVE_BUILTIN_TOOL_NAMES.has(name)) throw new AppError("AGENT_SKILL_EXPERIMENT_UNSUPPORTED", `Нет инструмента в текущем режиме: ${name}`);
    if (["read_file", "write_file"].includes(name)) continue;
    const tool = Object.hasOwn(application, name) ? application[name] : native[name];
    // Eve exposes no public descriptor for provider search, agent or ask_question.
    // Their scenario contract intentionally proves decisions only, not API compatibility.
    const schema = tool?.inputSchema;
    const inputSchema = schema && "~standard" in schema ? await asSchema(schema as Parameters<typeof asSchema>[0]).jsonSchema : schema;
    result[name] = {
      description: tool?.description ?? `Тестовый сценарий инструмента ${name}. Передай аргументы действия; реальное действие не выполняется.`,
      inputSchema: inputSchema as Record<string, unknown> ?? { type: "object", additionalProperties: true },
      source: tool ? Object.hasOwn(application, name) ? "application" : "eve" : "generic_scenario",
    };
  }
  return result;
}
