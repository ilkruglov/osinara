import type { CompiledAgentManifest } from "#compiler/manifest.js";
/**
 * The materialized instrumentation modules, mirroring the layout they were
 * authored in. Paths are relative to `.eve/compile`.
 */
export type MaterializedInstrumentation = {
    readonly kind: "file";
    readonly modulePath: string;
} | {
    readonly kind: "directory";
    readonly modulePathsBySlot: Readonly<Record<string, string>>;
};
export interface MaterializedAuthoredModuleIndex {
    readonly fingerprint: string;
    readonly instrumentation?: MaterializedInstrumentation;
    readonly moduleMap: string;
    readonly version: 3;
}
type PreparedMaterializedInstrumentation = {
    readonly kind: "file";
    readonly moduleCode: string;
} | {
    readonly kind: "directory";
    readonly moduleCodeBySlot: Readonly<Record<string, string>>;
};
export interface PreparedMaterializedAuthoredModules {
    readonly instrumentation?: PreparedMaterializedInstrumentation;
    readonly moduleMapCode: string;
}
export declare function prepareMaterializedAuthoredModules(input: {
    readonly manifest: CompiledAgentManifest;
    readonly moduleMapPath: string;
}): Promise<PreparedMaterializedAuthoredModules>;
export declare function writeMaterializedAuthoredModules(input: {
    readonly prepared: PreparedMaterializedAuthoredModules;
    readonly runtimeAppRoot: string;
}): Promise<MaterializedAuthoredModuleIndex>;
export declare function readMaterializedAuthoredModuleIndex(runtimeAppRoot: string): Promise<MaterializedAuthoredModuleIndex | undefined>;
export {};
