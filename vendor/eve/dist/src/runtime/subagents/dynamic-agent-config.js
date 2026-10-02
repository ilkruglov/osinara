import { serializeOutputSchema } from "#shared/tool-schema.js";
import { normalizeAgentDefinition } from "#internal/authored-definition/core.js";
import { isDynamicModelDefinition } from "#shared/agent-definition.js";
import { resolveRuntimeModelSelection } from "#runtime/agent/resolve-model.js";
async function normalizeDynamicSubagentAgentConfig(t) {
  let n = `Dynamic subagent "${t.name}" must return defineAgent(...), defineRemoteAgent(...), or null.`,
    r = normalizeAgentDefinition(t.value, n);
  if (!r.description) throw Error(`${n} The "description" field is required.`);
  if (r.build !== void 0)
    throw Error(`${n} The "build" field cannot be selected at runtime.`);
  if (r.experimental !== void 0)
    throw Error(`${n} The "experimental" field cannot be selected at runtime.`);
  if (isDynamicModelDefinition(r.model))
    throw Error(`${n} The returned "model" must be static.`);
  let i = {
    description: r.description,
    model: await normalizeDurableModelSelection({
      catalog: t.catalog,
      selection: {
        model: r.model,
        modelContextWindowTokens: r.modelContextWindowTokens,
        modelOptions: r.modelOptions,
      },
      state: t.state,
    }),
  };
  if (r.compaction !== void 0) {
    let e = {};
    (r.compaction.model !== void 0 &&
      (e.model = await normalizeDurableModelSelection({
        catalog: t.catalog,
        selection: {
          model: r.compaction.model,
          modelContextWindowTokens: r.compaction.modelContextWindowTokens,
          modelOptions: r.modelOptions,
        },
        state: t.state,
      })),
      r.compaction.thresholdPercent !== void 0 &&
        (e.thresholdPercent = r.compaction.thresholdPercent),
      (i.compaction = e));
  }
  return (
    r.limits !== void 0 && (i.limits = r.limits),
    r.outputSchema !== void 0 &&
      (i.outputSchema = serializeOutputSchema(r.outputSchema)),
    r.reasoning !== void 0 && (i.reasoning = r.reasoning),
    i
  );
}
async function normalizeDurableModelSelection(e) {
  return (
    await resolveRuntimeModelSelection({
      catalog: e.catalog,
      durability: `durable`,
      selection: e.selection,
      state: e.state,
    })
  ).reference;
}
export { normalizeDynamicSubagentAgentConfig };
