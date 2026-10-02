import { z } from "#compiled/zod/index.js";
export { catalogModelProviderSchema, catalogModelSchema, modelCatalogResponseSchema, } from "#internal/model-catalog.js";
export type { CatalogModelProvider, CatalogModel } from "#internal/model-catalog.js";
/**
 * Stable runtime model limits that eve can embed in compiled artifacts without
 * resolving provider metadata at runtime.
 */
export type CompiledRuntimeModelLimits = z.infer<typeof compiledRuntimeModelLimitsSchema>;
declare const compiledRuntimeModelLimitsSchema: z.ZodObject<{
    contextWindowTokens: z.ZodNumber;
    maxOutputTokens: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
/**
 * Loader that resolves compile-time model limits for one application build.
 */
export interface CompiledRuntimeModelCatalogLoader {
    getModelLimits(modelId: string): Promise<CompiledRuntimeModelLimits | null>;
    getByProviderModelId(provider: string, providerModelId: string): Promise<{
        slug: string;
        limits: CompiledRuntimeModelLimits;
    } | null>;
}
/**
 * Resolves the app-local cache path used for AI Gateway model metadata during
 * compilation.
 */
export declare function resolveCompiledRuntimeModelCatalogCachePath(appRoot: string): string;
/**
 * Creates a per-build loader that caches the AI Gateway model catalog in
 * memory and on disk.
 */
export declare function createCompiledRuntimeModelCatalogLoader(appRoot: string): CompiledRuntimeModelCatalogLoader;
