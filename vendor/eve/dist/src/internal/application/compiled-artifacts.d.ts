import type { CompileMetadata } from "#compiler/artifacts.js";
import type { CompileAgentResult } from "#compiler/compile-agent.js";
import type { AgentWorkflowWorldDefinition } from "#shared/agent-definition.js";
export type BuiltInWorkflowWorldTarget = "local" | "vercel";
export type GeneratedInstrumentationLayout = {
    readonly kind: "file";
} | {
    readonly kind: "directory";
    readonly slots: readonly string[];
};
/**
 * Paths to the generated compiled-artifacts files shared by Nitro and the
 * vendored workflow bundles for one application.
 */
export interface GeneratedCompiledArtifactsFiles {
    /**
     * Shared bundled-artifacts bootstrap installed by Nitro and vendored
     * workflow handlers.
     */
    bootstrapPath: string;
    /** Nitro plugin that installs the selected vendored Workflow world. */
    workflowWorldPluginPath: string;
    /**
     * Optional Nitro plugin that imports the authored instrumentation modules
     * from the application when present.
     */
    instrumentationPluginPath?: string;
    /** Layout identity used by dev plugin selection and structural fingerprinting. */
    instrumentationLayout?: GeneratedInstrumentationLayout;
    /**
     * Absolute paths to the authored instrumentation modules when present — one
     * for the file layout, one per provider in the directory layout. Nitro uses these
     * to preserve each module's side effects during bundling.
     */
    instrumentationSourcePaths?: readonly string[];
}
/**
 * Writes the generated compiled-artifacts bootstrap module.
 *
 * The bootstrap self-installs bundled artifacts on import and exports a
 * default function so it can be used directly as a Nitro plugin — no
 * separate plugin wrapper file is needed.
 */
export declare function writeCompiledArtifactsFiles(input: {
    compileResult: CompileAgentResult;
    defaultWorkflowWorld: BuiltInWorkflowWorldTarget;
    outDir: string;
}): Promise<GeneratedCompiledArtifactsFiles>;
export declare function writeDevelopmentCompiledArtifactsFiles(input: {
    readonly compileResult: CompileAgentResult;
    readonly outDir: string;
    readonly runtimeAppRoot: string;
}): Promise<GeneratedCompiledArtifactsFiles>;
export declare function createCompiledArtifactsBootstrapSource(input: {
    compileResult: CompileAgentResult;
    installModulePath: string;
    metadata: CompileMetadata;
    moduleMapPath: string;
}): Promise<string>;
export declare function createWorkflowWorldPluginSource(input: {
    compiledArtifactsBootstrapPath: string;
    configuredWorld: AgentWorkflowWorldDefinition | undefined;
    defaultWorld: BuiltInWorkflowWorldTarget;
}): string;
/**
 * Generates the dev worker's Workflow World wiring. Configs that resolve to
 * the vendored local World get the parent RPC client so run state survives
 * worker replacement; any other World is instantiated inside the worker
 * unchanged, because eve does not own its lifetime. The selection predicate
 * is shared with the parent's world creation — a worker wired for the RPC
 * client fails every World call unless the parent created a World to serve
 * it.
 */
export declare function createDevelopmentWorkflowWorldPluginSource(input: {
    compiledArtifactsBootstrapPath: string;
    configuredWorld: AgentWorkflowWorldDefinition | undefined;
}): string;
