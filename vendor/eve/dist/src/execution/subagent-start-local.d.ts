import type { DispatchOutcome, RuntimeSession } from "#execution/agent-handle-dispatch.js";
import { buildSubagentRunInput, type SubagentInputSource } from "#execution/subagent-tool.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import type { RuntimeSubagentCallActionRequest } from "#runtime/actions/types.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
type DynamicSubagentAgentConfig = Parameters<typeof createWorkflowRuntime>[0]["dynamicSubagentAgentConfig"];
/** Starts one local subagent after dispatch planning has selected its target. */
export declare function startLocalSubagent(input: {
    readonly action: RuntimeSubagentCallActionRequest;
    readonly auth: Parameters<typeof buildSubagentRunInput>[0]["auth"];
    readonly batchEvent: {
        readonly sequence: number;
        readonly turnId: string;
    };
    readonly bundle: CompiledBundle;
    readonly capabilities: Parameters<typeof buildSubagentRunInput>[0]["capabilities"];
    readonly channelMetadata: Parameters<typeof buildSubagentRunInput>[0]["channelMetadata"];
    readonly currentSession: RuntimeSession;
    readonly dynamicSubagentAgentConfig?: DynamicSubagentAgentConfig;
    readonly fanoutSize: number;
    readonly initiatorAuth: Parameters<typeof buildSubagentRunInput>[0]["initiatorAuth"];
    readonly parentContinuationToken: string | undefined;
    readonly parentTraceContext: Parameters<typeof buildSubagentRunInput>[0]["parentTraceContext"];
    readonly persistentSessions: boolean;
    readonly sandboxSessionId: string;
    readonly session: RuntimeSession;
    readonly source: SubagentInputSource;
    readonly taskOwned: boolean;
}): Promise<DispatchOutcome>;
export {};
