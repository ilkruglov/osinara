export interface RuntimeModelMetadata {
    readonly contextWindowTokens: number;
    readonly maxOutputTokens?: number;
    readonly resolvedModelId: string;
}
export interface RuntimeModelCatalog {
    getByGatewayId(modelId: string): Promise<RuntimeModelMetadata | null>;
    getByProviderModelId(provider: string, providerModelId: string): Promise<RuntimeModelMetadata | null>;
}
export declare function createRuntimeModelCatalog(fetchCatalog?: typeof globalThis.fetch): RuntimeModelCatalog;
