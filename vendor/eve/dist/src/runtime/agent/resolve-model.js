import { RuntimeModelMetadataCacheKey } from "#context/keys.js";
import { normalizeCatalogModelId } from "#internal/model-catalog.js";
import { normalizeAgentDefinition } from "#internal/authored-definition/core.js";
import { formatLanguageModelGatewayId } from "#internal/runtime-model.js";
import { parseJsonObject } from "#shared/json.js";
import { isDynamicModelDefinition } from "#shared/agent-definition.js";
import { loadResolvedModuleExport } from "#runtime/resolve-helpers.js";
import { resolveBootstrapRuntimeModel } from "#runtime/agent/bootstrap-model.js";
import {
  resolveMockAuthoredRuntimeModel,
  shouldMockAuthoredRuntimeModels,
} from "#runtime/agent/mock-model-adapter.js";
import { createRuntimeModelCatalog } from "#runtime/agent/model-catalog.js";
async function resolveRuntimeModelReference(e, t) {
  let n = resolveBootstrapRuntimeModel(e);
  if (n !== null) return n;
  let r = resolveMockAuthoredRuntimeModel(e);
  return r === null
    ? isSourceBackedRuntimeModelReference(e)
      ? await loadSourceBackedRuntimeModelReference(e, t)
      : e.id
    : r;
}
async function loadSourceBackedRuntimeModelReference(e, t) {
  if (t === void 0)
    throw Error(
      `Expected a compiled module-map scope to resolve the authored runtime model "${e.id}".`,
    );
  let r = normalizeAgentDefinition(
    await loadResolvedModuleExport({
      definition: e.source,
      kindLabel: `runtime model "${e.id}"`,
      moduleMap: t.moduleMap,
      nodeId: t.nodeId,
    }),
    `Expected the authored agent config export "${e.source.exportName ?? `default`}" from "${e.source.logicalPath}" to match the public eve shape.`,
  ).model;
  if (r === void 0)
    throw Error(
      `Expected the authored agent config export "${e.source.exportName ?? `default`}" from "${e.source.logicalPath}" to provide a runtime model.`,
    );
  if (isDynamicModelDefinition(r))
    throw Error(
      `Expected the authored agent config export "${e.source.exportName ?? `default`}" from "${e.source.logicalPath}" to provide a static runtime model.`,
    );
  return r;
}
function isSourceBackedRuntimeModelReference(e) {
  return e.source !== void 0;
}
async function loadDynamicRuntimeModelDefinition(e) {
  let t = normalizeAgentDefinition(
    await loadResolvedModuleExport({
      definition: e.dynamicModel,
      kindLabel: `dynamic runtime model`,
      moduleMap: e.scope.moduleMap,
      nodeId: e.scope.nodeId,
    }),
    `Expected the authored agent config export "${e.dynamicModel.exportName ?? `default`}" from "${e.dynamicModel.logicalPath}" to match the public eve shape.`,
  ).model;
  if (!isDynamicModelDefinition(t))
    throw Error(
      `Expected the authored agent config export "${e.dynamicModel.exportName ?? `default`}" from "${e.dynamicModel.logicalPath}" to provide a dynamic model definition.`,
    );
  return t;
}
async function resolveRuntimeModelSelection(e) {
  if (e.selection === null || e.selection === void 0)
    throw Error(
      `Dynamic model resolver returned no model. Every matching dynamic model handler must return a concrete model selection.`,
    );
  let n = normalizeDynamicModelSelection(e.selection);
  validateDynamicModelSelection(n);
  let i =
      n.modelOptions?.providerOptions === void 0
        ? void 0
        : parseProviderOptionsRecord(n.modelOptions.providerOptions),
    a = n.model,
    o = e.catalog ?? runtimeModelCatalogForState(e.state);
  if (typeof a == `string`) {
    let s = formatLanguageModelGatewayId(a),
      c = await resolveSelectionMetadata({
        cacheKey: `gateway:${normalizeCatalogModelId(s)}`,
        catalog: o,
        contextWindowTokens: n.modelContextWindowTokens,
        load: (e) => e.getByGatewayId(s),
        modelLabel: s,
        state: e.state,
      });
    return {
      reference: {
        id: c.resolvedModelId,
        contextWindowTokens: c.contextWindowTokens,
        maxOutputTokens: c.maxOutputTokens,
        providerOptions: i,
      },
    };
  }
  if ((validateRuntimeLanguageModel(a), e.durability === `durable`))
    throw Error(
      `Dynamic model selection returned a provider object, but durable model selections must be serializable. Return a model id string, or use a "step.started" model resolver.`,
    );
  let s = formatLanguageModelGatewayId(a),
    c = a.provider.split(`.`)[0],
    l = await resolveSelectionMetadata({
      cacheKey:
        c === `gateway`
          ? `gateway:${normalizeCatalogModelId(a.modelId)}`
          : `provider:${a.provider}:${normalizeCatalogModelId(a.modelId)}`,
      catalog: o,
      contextWindowTokens: n.modelContextWindowTokens,
      load: (e) =>
        c === `gateway`
          ? e.getByGatewayId(a.modelId)
          : e.getByProviderModelId(a.provider, a.modelId),
      modelLabel: s,
      state: e.state,
    });
  return {
    model: a,
    reference: {
      id: l.resolvedModelId,
      contextWindowTokens: l.contextWindowTokens,
      maxOutputTokens: l.maxOutputTokens,
      providerOptions: i,
    },
  };
}
const runtimeModelCatalogsByState = new WeakMap();
function runtimeModelCatalogForState(e) {
  let t = runtimeModelCatalogsByState.get(e);
  if (t !== void 0) return t;
  let n = createRuntimeModelCatalog();
  return (runtimeModelCatalogsByState.set(e, n), n);
}
async function resolveSelectionMetadata(t) {
  if (t.contextWindowTokens !== void 0)
    return {
      contextWindowTokens: t.contextWindowTokens,
      resolvedModelId: t.modelLabel,
    };
  let n = Date.now(),
    r = t.state.get(RuntimeModelMetadataCacheKey)?.[t.cacheKey];
  if (r !== void 0 && r.expiresAt > n) return r;
  let i = await t.load(t.catalog);
  if (i === null)
    throw Error(
      `Cannot select model "${t.modelLabel}" because AI Gateway did not provide context window metadata. Return modelContextWindowTokens with this selection for an unlisted or custom model.`,
    );
  let a = { ...i, expiresAt: n + 864e5 };
  return (
    t.state.set(RuntimeModelMetadataCacheKey, (e) => ({
      ...Object.fromEntries(
        Object.entries(e ?? {}).filter(([, e]) => e.expiresAt > n),
      ),
      [t.cacheKey]: a,
    })),
    a
  );
}
const DYNAMIC_MODEL_SELECTION_KEYS = new Set([
  `model`,
  `modelContextWindowTokens`,
  `modelOptions`,
]);
function validateDynamicModelSelection(e) {
  let t = Object.keys(e).filter((e) => !DYNAMIC_MODEL_SELECTION_KEYS.has(e));
  if (t.length > 0)
    throw Error(
      `Dynamic model resolver returned a selection with unknown key(s): ${t.join(`, `)}. Expected { model, modelContextWindowTokens?, modelOptions? }.`,
    );
  let n = e.modelContextWindowTokens;
  if (n !== void 0 && (!Number.isInteger(n) || n <= 0))
    throw Error(
      `Dynamic model resolver returned an invalid modelContextWindowTokens value. Expected a positive integer.`,
    );
  if (typeof e.model == `string` && e.model.trim() === ``)
    throw Error(`Dynamic model resolver returned an empty model id.`);
}
function normalizeDynamicModelSelection(e) {
  return isModelSelectionDefinition(e) ? e : { model: e };
}
function isModelSelectionDefinition(e) {
  return (
    typeof e == `object` && !!e && `model` in e && !isRuntimeLanguageModel(e)
  );
}
function validateRuntimeLanguageModel(e) {
  if (!isRuntimeLanguageModel(e))
    throw Error(
      `Dynamic model resolver returned an invalid model. Return an AI Gateway model id string, an AI SDK language model, or { model, modelContextWindowTokens?, modelOptions? }.`,
    );
}
function isRuntimeLanguageModel(e) {
  if (typeof e != `object` || !e) return !1;
  let t = e;
  return (
    (t.specificationVersion === `v2` ||
      t.specificationVersion === `v3` ||
      t.specificationVersion === `v4`) &&
    typeof t.provider == `string` &&
    typeof t.modelId == `string` &&
    typeof t.doGenerate == `function` &&
    typeof t.doStream == `function`
  );
}
function parseProviderOptionsRecord(e) {
  if (e === void 0) return;
  let t = {};
  for (let [n, r] of Object.entries(e)) t[n] = parseJsonObject(r);
  return t;
}
export {
  isRuntimeLanguageModel,
  loadDynamicRuntimeModelDefinition,
  resolveRuntimeModelReference,
  resolveRuntimeModelSelection,
  shouldMockAuthoredRuntimeModels,
};
