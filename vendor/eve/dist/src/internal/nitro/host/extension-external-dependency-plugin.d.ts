interface BundlerPluginShape {
    readonly name: string;
    resolveId(source: string): {
        external: true;
        id: string;
    } | null;
}
interface ExtensionExternalDependencyMount {
    readonly externalDependencies: readonly string[];
    readonly sourceRoot: string;
}
/** Keeps extension-owned runtime packages external so Nitro can preserve their full package trees. */
export declare function createExtensionExternalDependencyPlugin(mounts: readonly ExtensionExternalDependencyMount[]): BundlerPluginShape | null;
/** Resolves package entries for Nitro's nft tracer from the mounted extension package. */
export declare function resolveExtensionExternalDependencyPaths(mounts: readonly ExtensionExternalDependencyMount[]): Record<string, string>;
export {};
