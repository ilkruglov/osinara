import { z } from "#compiled/zod/index.js";
const catalogModelProviderSchema = z
    .object({
      provider: z.string().min(1),
      providerModelId: z.string().min(1),
      contextWindowTokens: z.number().int().nonnegative().optional(),
      maxOutputTokens: z.number().int().nonnegative().optional(),
    })
    .passthrough(),
  catalogModelSchema = z
    .object({
      slug: z.string().min(1),
      providers: z.array(catalogModelProviderSchema).min(1),
    })
    .passthrough(),
  modelCatalogResponseSchema = z
    .object({
      models: z.array(catalogModelSchema),
      providerAliases: z.record(z.string(), z.string()),
    })
    .passthrough();
function normalizeCatalogModelId(e) {
  return e.endsWith(`-thinking`) ? e.slice(0, -9) : e;
}
function findCatalogModelBySlug(e, t) {
  return e.find((e) => e.slug === normalizeCatalogModelId(t));
}
function findCatalogModelByProviderModelId(e) {
  let t = e.provider.split(`.`)[0],
    n = e.providerAliases[t] ?? t,
    r = normalizeCatalogModelId(e.providerModelId);
  for (let t of e.models)
    for (let e of t.providers)
      if (e.provider === n && normalizeCatalogModelId(e.providerModelId) === r)
        return { model: t, provider: e };
  return null;
}
function modelCatalogLimitsFromProvider(e) {
  return e.contextWindowTokens === void 0 || e.contextWindowTokens <= 0
    ? null
    : {
        contextWindowTokens: e.contextWindowTokens,
        ...(e.maxOutputTokens !== void 0 &&
          e.maxOutputTokens > 0 && { maxOutputTokens: e.maxOutputTokens }),
      };
}
export {
  catalogModelProviderSchema,
  catalogModelSchema,
  findCatalogModelByProviderModelId,
  findCatalogModelBySlug,
  modelCatalogLimitsFromProvider,
  modelCatalogResponseSchema,
  normalizeCatalogModelId,
};
