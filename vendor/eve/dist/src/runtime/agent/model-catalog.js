import {
  AI_GATEWAY_MODELS_CATALOG_URL,
  vercelGatewayFetch,
} from "#internal/gateway.js";
import {
  findCatalogModelByProviderModelId,
  findCatalogModelBySlug,
  modelCatalogLimitsFromProvider,
  modelCatalogResponseSchema,
} from "#internal/model-catalog.js";
function createRuntimeModelCatalog(i = vercelGatewayFetch) {
  let a = null,
    loadCatalog = async () => (
      a === null &&
        (a = i(AI_GATEWAY_MODELS_CATALOG_URL)
          .then(async (e) => {
            if (!e.ok)
              throw Error(
                `AI Gateway model catalog request failed with HTTP ${e.status} ${e.statusText}.`,
              );
            return parseCatalogResponse(await e.json());
          })
          .catch((e) => {
            throw ((a = null), e);
          })),
      await a
    );
  return {
    async getByGatewayId(e) {
      let t = findCatalogModelBySlug((await loadCatalog()).models, e);
      if (t === void 0) return null;
      for (let e of t.providers) {
        let n = modelCatalogLimitsFromProvider(e);
        if (n !== null) return { ...n, resolvedModelId: t.slug };
      }
      return null;
    },
    async getByProviderModelId(e, t) {
      let r = await loadCatalog(),
        i = findCatalogModelByProviderModelId({
          models: r.models,
          provider: e,
          providerAliases: r.providerAliases,
          providerModelId: t,
        });
      if (i === null) return null;
      let a = modelCatalogLimitsFromProvider(i.provider);
      return a === null ? null : { ...a, resolvedModelId: i.model.slug };
    },
  };
}
function parseCatalogResponse(e) {
  let t = modelCatalogResponseSchema.safeParse(e);
  if (!t.success)
    throw Error(
      `AI Gateway model catalog response did not match the expected schema.`,
    );
  return t.data;
}
export { createRuntimeModelCatalog };
