import { createHash } from "node:crypto";
import { defineHook } from "eve/hooks";
import { experimentHash, experimentPath, scoreArtifact } from "../../../../agent/lib/authored-skills/skill-experiment.js";
import { scoreScenarioCheck, type ScenarioCall } from "../../../../agent/lib/authored-skills/skill-scenario.js";
import { evaluateSkillRubric } from "../../../../agent/lib/authored-skills/skill-rubric.js";
import { labToolPublicName } from "../../../../agent/lib/authored-skills/skill-lab-model.js";
import { job, journal } from "../lib/job.js";
import { judge } from "../lib/judge.js";
const calls = new Map<string, ScenarioCall>();
let answer = "";
export default defineHook({ events: {
  "message.completed"(event) { answer = event.data.message ?? ""; },
  "actions.requested"(event) {
    answer = ""; // Progress text before a tool is not the final answer.
    for (const action of event.data.actions) {
      if (action.kind === "tool-call") calls.set(action.callId, { toolName: labToolPublicName(action.toolName), input: action.input });
      else if (action.kind === "load-skill") calls.set(action.callId, { toolName: "load_skill", input: action.input });
    }
  },
  "action.result"(event) {
    const result = event.data.result;
    if (result.kind === "tool-result") {
      const call = calls.get(result.callId);
      if (call) { call.output = result.output; call.succeeded = event.data.status === "completed" && !result.isError; }
    }
    const requested = calls.get(result.callId)?.input;
    if (result.kind === "tool-result" && result.toolName === "load_skill" && !result.isError &&
      requested && typeof requested === "object" && "skill" in requested && requested.skill === job().skill?.name &&
      event.data.status === "completed" && typeof result.output === "string" && result.output.trim() === job().skill?.markdown.trim()) journal({ kind: "loaded" });
  },
  async "turn.completed"(_event, ctx) {
    const sandbox = await ctx.getSandbox();
    const passed: boolean[] = [];
    const hashes: Record<string, string> = {};
    const files: Record<string, string> = {};
    const paths = new Set([
      ...Object.keys(job().testCase.files),
      ...job().testCase.checks.flatMap((c) => "path" in c ? [c.path] : []),
      ...(job().testCase.toolFixtures ?? []).flatMap((f) => Object.keys(f.files ?? {})),
      ...[...calls.values()].flatMap((c) => c.toolName === "write_file" && c.input && typeof c.input === "object" && "filePath" in c.input && typeof c.input.filePath === "string" ? [c.input.filePath] : []),
    ]);
    for (const path of paths) {
      if (!experimentPath.safeParse(path).success) continue;
      try {
        const content = await sandbox.readTextFile({ path });
        if (content !== null && content !== undefined) { files[path] = content; hashes[path] = createHash("sha256").update(content).digest("hex"); }
      } catch { /* Missing artifact fails its check. */ }
    }
    const observations = [...calls.values()].filter((c) => c.toolName !== "load_skill");
    for (const check of job().testCase.checks) {
      if ("path" in check) passed.push(scoreArtifact(check, files[check.path]));
      else if (check.target === "rubric") passed.push(await evaluateSkillRubric(check,
        { request: job().testCase.request, answer, calls: observations, files }, judge));
      else passed.push(scoreScenarioCheck(check, answer, [...calls.values()]));
    }
    hashes.answer = experimentHash(answer);
    hashes.actions = experimentHash(observations);
    journal({ kind: "result", passed, hashes, sessionId: ctx.session.id, turnId: ctx.session.turn.id });
  },
} });
