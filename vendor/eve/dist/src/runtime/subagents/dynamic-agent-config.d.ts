import type { ContextAccessor } from "#context/key.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import type { RuntimeModelCatalog } from "#runtime/agent/model-catalog.js";
import { type AgentLimitsDefinition, type AgentReasoningDefinition } from "#shared/agent-definition.js";
import type { JsonObject } from "#shared/json.js";
export interface DynamicSubagentAgentConfig {
    readonly compaction?: {
        readonly model?: DynamicSubagentModelReference;
        readonly thresholdPercent?: number;
    };
    readonly description: string;
    readonly limits?: AgentLimitsDefinition;
    readonly model: DynamicSubagentModelReference;
    readonly outputSchema?: JsonObject;
    readonly reasoning?: AgentReasoningDefinition;
}
export type DynamicSubagentModelReference = RuntimeModelReference;
export declare function normalizeDynamicSubagentAgentConfig(input: {
    readonly catalog?: RuntimeModelCatalog;
    readonly name: string;
    readonly state: ContextAccessor;
    readonly value: unknown;
}): Promise<DynamicSubagentAgentConfig>;
