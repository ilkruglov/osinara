/** Fixed experimental policy: reserve once, run every pair, never retry an ambiguous execution. */
import type { FamilyCaller } from "../family-context.js";
import { modelProviderConfig } from "../model-provider-config.js";
import { skillExperimentRepository as repo } from "./skill-experiment-repository.js";
import { runSkillLab } from "./skill-lab-runner.js";

export async function runSkillExperiment(caller: FamilyCaller, id: string, signal: AbortSignal) {
  const batch = await repo.start(caller, id);
  if (!batch) return repo.status(caller, id);
  const timeout = AbortSignal.timeout(batch.experiment.protocol.maxSeconds * 1000);
  const deadlineAt = Date.now() + batch.experiment.protocol.maxSeconds * 1000;
  const cancelled = new AbortController();
  const combined = AbortSignal.any([signal, timeout, cancelled.signal]);
  let polling = false;
  const monitor = setInterval(() => {
    if (polling) return;
    polling = true;
    void repo.isRunning(caller, id).then((running) => { if (!running) cancelled.abort(); }, () => cancelled.abort()).finally(() => { polling = false; });
  }, 1000);
  try {
    for (const run of batch.runs) {
      if (combined.aborted || !await repo.reserveRun(caller, id, run.id)) break;
      const testCase = batch.experiment.protocol.cases.find((c) => c.id === run.case_id)!;
      const skill = run.variant === "baseline" ? batch.experiment.baseline : batch.candidates.find((c) => c.id === run.variant)!.draft;
      const result = await runSkillLab({ runId: run.id, skill, testCase, maxCalls: batch.experiment.protocol.maxCallsPerRun, model: modelProviderConfig.agent,
        toolContracts: batch.experiment.tool_contracts, environment: batch.experiment.protocol.environment },
        AbortSignal.any([combined, AbortSignal.timeout(90_000)]), { deadlineAt });
      await repo.completeRun(id, run.id, result);
    }
  } finally { clearInterval(monitor); await repo.finish(id); }
  return repo.status(caller, id);
}
