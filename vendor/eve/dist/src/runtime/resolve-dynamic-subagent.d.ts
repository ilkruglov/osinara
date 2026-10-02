import type { CompiledDynamicSubagentDefinition } from "#compiler/remote-agent-node.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import type { ResolvedDynamicSubagentDefinition } from "#runtime/types.js";
export declare function resolveDynamicSubagentDefinition(input: {
    readonly definition: CompiledDynamicSubagentDefinition;
    readonly moduleMap: CompiledModuleMap;
    readonly nodeId: string;
}): Promise<ResolvedDynamicSubagentDefinition>;
export declare function normalizeResolvedDynamicSubagentDefinition(definition: CompiledDynamicSubagentDefinition, value: unknown): ResolvedDynamicSubagentDefinition;
