import { DynamicSubagentAgentConfigKey } from "#context/keys.js";
function resolveEffectiveAgentRuntime(t, n) {
  return resolveEffectiveAgentRuntimeFromConfig(
    t,
    n.get(DynamicSubagentAgentConfigKey),
  );
}
function resolveEffectiveAgentRuntimeFromConfig(e, t) {
  if (t === void 0) {
    if (e.turnAgent.configResolver === !0)
      throw Error(
        `Dynamic subagent execution requires a selected concrete agent config.`,
      );
    return {
      limits: e.resolvedAgent.config?.limits,
      thresholdPercent: e.resolvedAgent.config?.compaction?.thresholdPercent,
      turnAgent: e.turnAgent,
    };
  }
  let {
    compactionModel: n,
    configResolver: r,
    dynamicModel: i,
    model: a,
    ...o
  } = e.turnAgent;
  return {
    limits: t.limits,
    thresholdPercent: t.compaction?.thresholdPercent,
    turnAgent: {
      ...o,
      compactionModel: t.compaction?.model,
      model: t.model,
      outputSchema: t.outputSchema,
      reasoning: t.reasoning,
    },
  };
}
export { resolveEffectiveAgentRuntime, resolveEffectiveAgentRuntimeFromConfig };
