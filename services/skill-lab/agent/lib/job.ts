/** Host-only manifest and append-only usage journal; neither is mounted into the sandbox. */
import { appendFileSync, readFileSync } from "node:fs";
import type { AuthoredSkillDraft } from "../../../../agent/lib/authored-skills/authored-skill-contract.js";
import type { ExperimentProtocol } from "../../../../agent/lib/authored-skills/skill-experiment.js";
import type { ModelProviderConfig } from "../../../../agent/lib/model-provider-config-schema.js";
import type { ScenarioToolContracts } from "../../../../agent/lib/authored-skills/skill-scenario.js";

export interface LabJob {
  runId: string;
  skill: AuthoredSkillDraft | null;
  testCase: ExperimentProtocol["cases"][number];
  maxCalls: number;
  model: ModelProviderConfig["agent"];
  deadlineAt?: number;
  toolContracts?: ScenarioToolContracts;
  environment?: "files" | "scenario";
}
let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
export function job(): LabJob {
  const path = process.env.SKILL_LAB_JOB;
  if (!path) throw new Error("AGENT_SKILL_LAB_JOB_MISSING");
  const value: LabJob = JSON.parse(readFileSync(path, "utf8"));
  if (value.deadlineAt !== undefined && !deadlineTimer) {
    // Survives loss of the supervising process: an orphan cannot keep calling the provider.
    deadlineTimer = setTimeout(() => process.exit(1), Math.max(1, value.deadlineAt - Date.now()));
    deadlineTimer.unref();
  }
  return value;
}
export function journal(entry: object) {
  const path = process.env.SKILL_LAB_JOURNAL;
  if (!path) throw new Error("AGENT_SKILL_LAB_JOURNAL_MISSING");
  appendFileSync(path, JSON.stringify(entry) + "\n", { mode: 0o600, flush: true });
}
export function reserveCall(role: "agent" | "judge" = "agent") {
  if ((job().deadlineAt ?? 0) <= Date.now()) throw new Error("AGENT_SKILL_LAB_DEADLINE");
  const path = process.env.SKILL_LAB_JOURNAL!;
  let entries: string[] = [];
  try { entries = readFileSync(path, "utf8").split("\n"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Eve may retry a failed hook. A judge with an ambiguous/invalid result is never called twice.
  if (role === "judge" && entries.some((line) => line && JSON.parse(line).kind === "call" && JSON.parse(line).role === "judge")) throw new Error("AGENT_SKILL_LAB_JUDGE_ALREADY_STARTED");
  if (entries.filter((line) => line && JSON.parse(line).kind === "call").length >= job().maxCalls) throw new Error("AGENT_SKILL_LAB_CALL_LIMIT");
  journal({ kind: "call", role, at: Date.now() });
}

// Arm the deadline on process startup, including a parent lost before its first HTTP request.
if (process.env.SKILL_LAB_JOB) job();
