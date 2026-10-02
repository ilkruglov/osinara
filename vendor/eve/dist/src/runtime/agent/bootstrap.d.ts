import type { ModelMessage } from "ai";
import type { PreparedRuntimeTool } from "#runtime/sessions/turn.js";
import type { ResolvedAgent, ResolvedAgentDefinition } from "#runtime/types.js";
import type { WorkspaceRuntimeSpec } from "#runtime/workspace/types.js";
import type { InternalAgentModelDefinition } from "#shared/agent-definition.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import type { AvailableSkillDescription } from "#execution/skills/instructions.js";
/**
 * Fixed internal model reference used only by the framework-owned bootstrap
 * runtime path.
 */
export declare const BOOTSTRAP_RUNTIME_MODEL_ID = "eve-bootstrap-model";
/**
 * Runtime-owned model identifier prepared for one harness turn.
 */
export type RuntimeModelReference = Readonly<InternalAgentModelDefinition>;
/**
 * Runtime-owned reference to a dynamic model resolver authored in `agent.ts`.
 */
export type RuntimeDynamicModelReference = Readonly<ModuleSourceRef & {
    readonly eventNames: readonly string[];
}>;
/**
 * Minimal runtime-owned agent shape prepared for one harness turn.
 */
interface RuntimeTurnAgentBase {
    readonly availableSkills?: readonly AvailableSkillDescription[];
    readonly id: string;
    readonly instructions: readonly string[];
    readonly initialMessages?: readonly ModelMessage[];
    /**
     * Optional model used only for compaction summaries.
     *
     * When omitted, the harness uses the active turn model for compaction.
     */
    readonly compactionModel?: RuntimeModelReference;
    readonly nodeId?: string;
    readonly outputSchema?: ResolvedAgentDefinition["outputSchema"];
    readonly reasoning?: ResolvedAgentDefinition["reasoning"];
    readonly tools: readonly PreparedRuntimeTool[];
    readonly workspaceSpec: WorkspaceRuntimeSpec;
}
export type RuntimeTurnAgent = RuntimeTurnAgentBase & ({
    readonly configResolver?: never;
    readonly dynamicModel?: never;
    readonly model: RuntimeModelReference;
} | {
    readonly dynamicModel: RuntimeDynamicModelReference;
    readonly configResolver?: never;
    readonly model?: never;
} | {
    readonly configResolver: true;
    readonly dynamicModel?: never;
    readonly model?: never;
});
/**
 * Static system prompt for the bootstrap runtime path.
 */
export declare const BOOTSTRAP_RUNTIME_SYSTEM_PROMPT = "You are the eve bootstrap agent. Be concise, stay grounded in the current conversation, and do not assume tools are available unless the runtime provides them.";
/**
 * Creates the runtime-owned turn-preparation shape from a resolved authored
 * agent and the authored tool descriptors prepared for the harness.
 */
export declare function createResolvedRuntimeTurnAgent(input: {
    readonly agent: ResolvedAgent;
    readonly id?: string;
    readonly nodeId?: string;
    readonly tools: readonly PreparedRuntimeTool[];
}): RuntimeTurnAgent;
export {};
