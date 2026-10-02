declare const PROVIDER_SELECTIONS: readonly ["chatgpt", "ai-gateway-key", "ai-gateway-project"];
export type ProviderSelection = (typeof PROVIDER_SELECTIONS)[number];
export declare function providerSettingsPath(appRoot: string): string;
export declare function resolveAvailableProviders(appRoot: string, options?: {
    signal?: AbortSignal;
    env?: Record<string, string | undefined>;
}): Promise<readonly ProviderSelection[]>;
export declare function readProviderSelection(appRoot: string): Promise<ProviderSelection | undefined>;
/** Synchronous counterpart for the synchronous dev-environment loader. */
export declare function readProviderSelectionSync(appRoot: string): ProviderSelection | undefined;
export declare function writeProviderSelection(appRoot: string, selected: ProviderSelection): Promise<void>;
export {};
