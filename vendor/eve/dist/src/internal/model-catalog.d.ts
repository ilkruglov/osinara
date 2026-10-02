import { z } from "#compiled/zod/index.js";
export declare const catalogModelProviderSchema: z.ZodObject<{
    provider: z.ZodString;
    providerModelId: z.ZodString;
    contextWindowTokens: z.ZodOptional<z.ZodNumber>;
    maxOutputTokens: z.ZodOptional<z.ZodNumber>;
}, z.core.$loose>;
export declare const catalogModelSchema: z.ZodObject<{
    slug: z.ZodString;
    providers: z.ZodArray<z.ZodObject<{
        provider: z.ZodString;
        providerModelId: z.ZodString;
        contextWindowTokens: z.ZodOptional<z.ZodNumber>;
        maxOutputTokens: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
}, z.core.$loose>;
export declare const modelCatalogResponseSchema: z.ZodObject<{
    models: z.ZodArray<z.ZodObject<{
        slug: z.ZodString;
        providers: z.ZodArray<z.ZodObject<{
            provider: z.ZodString;
            providerModelId: z.ZodString;
            contextWindowTokens: z.ZodOptional<z.ZodNumber>;
            maxOutputTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    providerAliases: z.ZodRecord<z.ZodString, z.ZodString>;
}, z.core.$loose>;
export type CatalogModelProvider = z.infer<typeof catalogModelProviderSchema>;
export type CatalogModel = z.infer<typeof catalogModelSchema>;
export interface ModelCatalogLimits {
    readonly contextWindowTokens: number;
    readonly maxOutputTokens?: number;
}
export declare function normalizeCatalogModelId(modelId: string): string;
export declare function findCatalogModelBySlug(models: readonly CatalogModel[], slug: string): CatalogModel | undefined;
export declare function findCatalogModelByProviderModelId(input: {
    readonly models: readonly CatalogModel[];
    readonly provider: string;
    readonly providerAliases: Readonly<Record<string, string>>;
    readonly providerModelId: string;
}): {
    readonly model: CatalogModel;
    readonly provider: CatalogModelProvider;
} | null;
export declare function modelCatalogLimitsFromProvider(provider: CatalogModelProvider): ModelCatalogLimits | null;
