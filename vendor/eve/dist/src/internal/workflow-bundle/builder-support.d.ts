import { type WorkflowManifest } from "#internal/workflow-bundle/workflow-builders.js";
export declare const WORKFLOW_VIRTUAL_ENTRY_ID = "\0eve-workflow-entry";
export interface WorkflowBundleBuilderOptions {
    agentName: string;
    appRoot: string;
    compiledArtifactsBootstrapPath: string;
    outDir: string;
    rootDir: string;
    watch: boolean;
    /** Test-harness-only: also scans `src/internal/testing/`. */
    includeTestFixtures?: boolean;
}
export interface WorkflowBundleBuilderConfig {
    readonly buildTarget: "standalone";
    readonly dirs: readonly string[];
    readonly externalPackages: readonly string[];
    readonly projectRoot: string;
    readonly watch: boolean;
    readonly workingDir: string;
}
export interface WorkflowBundleDiscoveredEntries {
    readonly discoveredSerdeFiles: string[];
    readonly discoveredSteps: string[];
    readonly discoveredWorkflows: string[];
}
export interface WorkflowBundleCreateWorkflowsBundleOptions {
    readonly additionalOutputs?: readonly WorkflowBundleOutput[];
    readonly discoveredEntries?: WorkflowBundleDiscoveredEntries;
    readonly inputFiles: readonly string[];
    readonly outfile: string;
    readonly stepRegistrationsPath: string;
    readonly tsconfigPath?: string;
}
export interface WorkflowBundleCreateWorkflowsBundleResult {
    readonly manifest: WorkflowManifest;
}
export interface WorkflowBundleOutput {
    readonly outfile: string;
    readonly stepRegistrationsPath: string;
}
interface WorkflowRolldownPlugin {
    readonly name: string;
    readonly resolveId?: (source: string, importer?: string) => unknown;
    readonly load?: (id: string) => unknown;
    readonly transform?: (code: string, id: string) => unknown;
}
export declare function collectWorkflowInputFiles(root: string): Promise<string[]>;
export declare function createWorkflowImport(filePath: string, workingDir: string): string;
export declare function createWorkflowVirtualEntryPlugin(source: string): WorkflowRolldownPlugin;
export declare function createWorkflowPseudoPackagePlugin(): WorkflowRolldownPlugin;
export declare function createWorkflowRuntimeAliasPlugin(): WorkflowRolldownPlugin;
export declare function createEvePackageImportsPlugin(workingDir: string, options?: {
    workflowCondition?: boolean;
}): WorkflowRolldownPlugin;
export declare function createWorkflowTransformPlugin(input: {
    manifest: WorkflowManifest;
    mode?: "step" | "workflow";
    projectRoot: string;
    sideEffectFiles?: readonly string[];
    workingDir: string;
}): WorkflowRolldownPlugin;
export declare function bundleWorkflowStepRegistrations(input: {
    builtinsPath: string;
    discoveredEntries: WorkflowBundleDiscoveredEntries;
    outfile: string;
    projectRoot: string;
    tsconfigPath?: string;
    workingDir: string;
}): Promise<void>;
export declare function createWorkflowNodeBuiltinGuardPlugin(): WorkflowRolldownPlugin;
export declare function bundleFinalWorkflowOutput(input: {
    code: string;
    outfile: string;
    queueNamespace: string;
    stepRegistrationsPath?: string;
}): Promise<void>;
export declare function createWorkflowEntrypointSource(input: {
    readonly code: string;
    readonly queueNamespace: string;
    readonly stepRegistrationsImport?: string;
}): string;
export declare function convertStepsManifest(steps: WorkflowManifest["steps"]): Record<string, unknown>;
export declare function convertWorkflowsManifest(workflows: WorkflowManifest["workflows"]): Record<string, unknown>;
export declare function convertClassesManifest(classes: WorkflowManifest["classes"]): Record<string, unknown>;
export {};
