/** Deterministic scenario coverage. Fixtures are simulations, never proof of an external effect. */
import { isDeepStrictEqual } from "node:util";
import { AppError } from "../app-error.js";
import { stepToolNames } from "./authored-skill-contract.js";
import { scoreArtifact, type ExperimentCheck, type ExperimentProtocol, type ToolFixture } from "./skill-experiment.js";

export interface ScenarioToolContract {
  description: string;
  inputSchema: Record<string, unknown>;
  source: "application" | "eve" | "generic_scenario";
}
export type ScenarioToolContracts = Record<string, ScenarioToolContract>;
export interface ScenarioCall { toolName: string; input: unknown; output?: unknown; succeeded?: boolean }
export function matchToolFixture(fixtures: readonly ToolFixture[], name: string, input: unknown): ToolFixture | undefined {
  return fixtures.find((f) => f.toolName === name && isDeepStrictEqual(f.input, input));
}
export function scoreScenarioCheck(check: Extract<ExperimentCheck, { target: "answer" | "tool" }>, answer: string, calls: readonly ScenarioCall[]): boolean {
  if (check.target === "answer") return scoreArtifact({ ...check, path: "/workspace/answer" }, answer);
  return calls.filter((c) => c.toolName === check.toolName && (check.input === undefined || isDeepStrictEqual(c.input, check.input))).length === check.count;
}
export function assertExperimentSkill(draft: { name: string; markdown: string }, protocol: ExperimentProtocol, contracts: ScenarioToolContracts): void {
  const actual = new Set(["read_file", "write_file", "load_skill"]);
  const unsupported = stepToolNames(draft.markdown).filter((name) => !actual.has(name) && !Object.hasOwn(contracts, name));
  if (unsupported.length) throw new AppError("AGENT_SKILL_EXPERIMENT_UNSUPPORTED", `Добавь тестовые сценарии для инструментов: ${unsupported.join(", ")}`);
  if (Object.keys(contracts).length && protocol.environment !== "scenario") throw new AppError("AGENT_SKILL_EXPERIMENT_UNSUPPORTED", "Требуется environment: scenario");
  if (protocol.cases.some((c) => c.toolFixtures?.some((f) => f.toolName === "load_skill" && f.input.skill === draft.name))) {
    throw new AppError("AGENT_SKILL_EXPERIMENT_UNSUPPORTED", "Испытуемый навык загружается из точного пакета, подмена запрещена");
  }
}
