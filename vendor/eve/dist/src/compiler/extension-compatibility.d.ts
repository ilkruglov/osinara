/** Stable kind for an extension distribution compatibility manifest. */
export declare const EXTENSION_COMPATIBILITY_MANIFEST_KIND = "eve-extension";
/** Current compatibility-manifest JSON format. */
export declare const EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION = 2;
/** Filename emitted at the root of an extension's agent-shaped dist tree. */
export declare const EXTENSION_COMPATIBILITY_MANIFEST_FILENAME = "_manifest.json";
declare const EXTENSION_CAPABILITY_CONTRACTS: {
    readonly extension: {
        readonly current: 1;
        readonly supported: readonly [1];
        readonly dropped: {};
    };
    readonly tool: {
        readonly current: 13;
        readonly supported: readonly [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
        readonly dropped: {};
    };
    readonly dynamicTool: {
        readonly current: 18;
        readonly supported: readonly [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
        readonly dropped: {};
    };
    readonly channel: {
        readonly current: 4;
        readonly supported: readonly [1, 2, 3, 4];
        readonly dropped: {};
    };
    readonly schedule: {
        readonly current: 2;
        readonly supported: readonly [1, 2];
        readonly dropped: {};
    };
    readonly subagent: {
        readonly current: 2;
        readonly supported: readonly [1, 2];
        readonly dropped: {};
    };
    readonly connection: {
        readonly current: 5;
        readonly supported: readonly [1, 2, 3, 4, 5];
        readonly dropped: {};
    };
    readonly hook: {
        readonly current: 14;
        readonly supported: readonly [10, 11, 12, 13, 14];
        readonly dropped: {
            readonly 1: "Model identity moved from session.started runtime metadata to step.started call attribution.";
            readonly 2: "Model identity moved from session.started runtime metadata to step.started call attribution.";
            readonly 3: "Model identity moved from session.started runtime metadata to step.started call attribution.";
            readonly 4: "Model identity moved from session.started runtime metadata to step.started call attribution.";
            readonly 5: "Model identity moved from session.started runtime metadata to step.started call attribution.";
            readonly 6: "Model identity moved from session.started runtime metadata to step.started call attribution.";
            readonly 7: "Model identity moved from session.started runtime metadata to step.started call attribution.";
            readonly 8: "Model identity moved from session.started runtime metadata to step.started call attribution.";
            readonly 9: "Model identity moved from session.started runtime metadata to step.started call attribution.";
        };
    };
    readonly skill: {
        readonly current: 1;
        readonly supported: readonly [1];
        readonly dropped: {};
    };
    readonly dynamicSkill: {
        readonly current: 12;
        readonly supported: readonly [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        readonly dropped: {};
    };
    readonly instructions: {
        readonly current: 2;
        readonly supported: readonly [1, 2];
        readonly dropped: {};
    };
    readonly dynamicInstructions: {
        readonly current: 13;
        readonly supported: readonly [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
        readonly dropped: {};
    };
    readonly config: {
        readonly current: 1;
        readonly supported: readonly [1];
        readonly dropped: {};
    };
    readonly state: {
        readonly current: 3;
        readonly supported: readonly [1, 2, 3];
        readonly dropped: {};
    };
};
/** One independently versioned extension-facing contract. */
export type ExtensionCapability = keyof typeof EXTENSION_CAPABILITY_CONTRACTS;
/** Current producer contract version for each extension-facing capability. */
export declare const EXTENSION_CAPABILITY_VERSIONS: { readonly [TCapability in ExtensionCapability]: (typeof EXTENSION_CAPABILITY_CONTRACTS)[TCapability]["current"]; };
/** Capability requirements stamped by one extension build. */
export type ExtensionCapabilityRequirements = Partial<Record<ExtensionCapability, number>>;
/**
 * Capability contract versions this eve release can consume.
 */
export declare const EXTENSION_CAPABILITY_SUPPORT: Readonly<Record<ExtensionCapability, readonly number[]>>;
/** Consumer support table used to validate one extension distribution. */
export type ExtensionCapabilitySupport = Readonly<Record<string, readonly number[]>>;
/** Compatibility-only metadata emitted by `eve extension build`. */
export interface ExtensionCompatibilityManifest {
    readonly kind: typeof EXTENSION_COMPATIBILITY_MANIFEST_KIND;
    readonly formatVersion: 1 | typeof EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION;
    /** Diagnostic producer version; capability requirements decide compatibility. */
    readonly builtWithEve: string;
    readonly requires: Readonly<Record<string, number>>;
    readonly build?: {
        readonly externalDependencies: readonly string[];
    };
}
/** One requirement the consuming eve cannot satisfy. */
export interface UnsupportedExtensionCapability {
    readonly capability: string;
    readonly requiredVersion: number;
    readonly supportedVersions: readonly number[];
}
/** Serializes a compatibility manifest deterministically. */
export declare function serializeExtensionCompatibilityManifest(manifest: ExtensionCompatibilityManifest): string;
/** Parses and validates compatibility-manifest JSON. */
export declare function parseExtensionCompatibilityManifest(raw: string, manifestPath: string): ExtensionCompatibilityManifest;
/** Reads and validates an extension compatibility manifest. */
export declare function readExtensionCompatibilityManifest(manifestPath: string): Promise<ExtensionCompatibilityManifest>;
/** Writes `_manifest.json` into an agent-shaped extension dist root. */
export declare function writeExtensionCompatibilityManifest(distRoot: string, manifest: ExtensionCompatibilityManifest): Promise<void>;
/** Finds unknown or unsupported capability requirements without executing extension code. */
export declare function findUnsupportedExtensionCapabilities(manifest: ExtensionCompatibilityManifest, support?: ExtensionCapabilitySupport): UnsupportedExtensionCapability[];
export {};
