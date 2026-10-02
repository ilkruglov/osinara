import { type AgentSourceManifest, type LocalSubagentSourceRef } from "#discover/manifest.js";
import { type CompiledAgentNodeManifest, type CompiledAgentResources, type CompiledRemoteAgentNode, type CompiledSubagentEdge, type CompiledSubagentNode } from "#compiler/manifest.js";
import { type ManifestCompileContext } from "#compiler/normalize-helpers.js";
/**
 * Callback the subagent compiler uses to recurse into the per-node
 * manifest compiler. Injected by `normalize-manifest.ts` so this module
 * does not have to import the orchestrator (which would create a
 * circular dependency).
 */
export type CompileAgentNodeManifestFn = (manifest: AgentSourceManifest, context: ManifestCompileContext, options?: {
    readonly agentConfigDefinition?: unknown;
    readonly externalDependencies?: readonly string[];
    readonly allowRootOnlyConfig?: boolean;
}) => Promise<CompiledAgentNodeManifest>;
export type CompileAgentResourcesFn = (manifest: AgentSourceManifest, context: ManifestCompileContext, options?: {
    readonly externalDependencies?: readonly string[];
}) => Promise<CompiledAgentResources>;
/**
 * Compiles every local subagent reachable from one parent node into a
 * flat node list and the parent→child edges that connect them.
 *
 * Recursive: each subagent may itself declare further subagents, which
 * are compiled depth-first via the injected `compileAgentNodeManifest`
 * callback.
 */
export declare function compileSubagentGraph(input: {
    readonly appRoot: string;
    readonly compileAgentNodeManifest: CompileAgentNodeManifestFn;
    readonly compileAgentResources: CompileAgentResourcesFn;
    readonly context: ManifestCompileContext;
    readonly externalDependencies?: readonly string[];
    readonly parentAgentRoot: string;
    readonly parentNodeId: string;
    readonly subagents: readonly LocalSubagentSourceRef[];
}): Promise<{
    readonly edges: readonly CompiledSubagentEdge[];
    readonly nodes: readonly CompiledSubagentNode[];
    readonly remoteAgents: readonly CompiledRemoteAgentNode[];
}>;
