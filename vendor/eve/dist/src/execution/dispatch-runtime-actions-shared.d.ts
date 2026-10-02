/**
 * Machinery shared by the two runtime-action dispatch steps:
 * `dispatchRuntimeActionsStep` (plain mode) and `dispatchTaskStep`
 * (task mode). Both run the same preflight → plan → dispatch → emit
 * skeleton over one pending batch and differ only in the per-entry
 * delegation lifecycle, so planning, subagent starts, and the
 * replay-safe `subagent.called` emission tail live here.
 */
import { type ChannelAdapter, type ChannelAdapterContext } from "#channel/adapter.js";
import { type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { type DispatchOutcome, type RuntimeAgentHandleAction, type RuntimeSession } from "#execution/agent-handle-dispatch.js";
import { getPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import type { RuntimeActionResult, RuntimeRemoteAgentCallActionRequest, RuntimeSubagentCallActionRequest, RuntimeSubagentDispatchFailure, RuntimeToolCallActionRequest } from "#runtime/actions/types.js";
import { type DurableSessionState } from "#execution/durable-session-store.js";
import { buildSubagentRunInput, type SubagentInputSource } from "#execution/subagent-tool.js";
import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
type DynamicSubagentAgentConfig = NonNullable<Extract<ReturnType<typeof getDynamicSubagentSelection>, {
    readonly kind: "subagent";
}>["agentConfig"]>;
type DynamicRemoteAgentConfig = NonNullable<Extract<ReturnType<typeof getDynamicSubagentSelection>, {
    readonly kind: "remote";
}>["remoteAgent"]>;
export type DispatchPlanEntry = {
    readonly kind: "resume";
    readonly action: RuntimeAgentHandleAction;
    readonly agentId: string;
    readonly dynamicRemoteAgent?: DynamicRemoteAgentConfig;
} | {
    readonly kind: "reject";
    readonly result: RuntimeSubagentDispatchFailure;
} | {
    readonly kind: "start";
    readonly target: DispatchStartTarget;
} | {
    readonly kind: "task-control";
    readonly action: RuntimeToolCallActionRequest;
};
export type DispatchStartTarget = {
    readonly kind: "local";
    readonly action: RuntimeSubagentCallActionRequest;
    readonly dynamicSubagentAgentConfig?: DynamicSubagentAgentConfig;
    readonly source: SubagentInputSource;
} | {
    readonly kind: "remote";
    readonly action: RuntimeRemoteAgentCallActionRequest;
    readonly dynamicRemoteAgent?: DynamicRemoteAgentConfig;
};
/** Input contract shared by both dispatch steps so the turn workflow can select either. */
export interface RuntimeActionDispatchInput {
    readonly callbackBaseUrl?: string;
    /** Internal hook that receives child completion and HITL payloads. */
    readonly parentContinuationToken?: string;
    readonly parentWritable: WritableStream<Uint8Array>;
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
}
/**
 * Result contract shared by both dispatch steps. `pendingTasks` is
 * always empty in plain mode; keeping it on both keeps the turn
 * workflow's acknowledgement call site uniform.
 */
export interface RuntimeActionDispatchResult {
    readonly results: readonly RuntimeActionResult[];
    readonly sessionState: DurableSessionState;
    readonly pendingTasks: readonly {
        readonly taskInboxToken: string;
        readonly taskId: string;
        readonly taskRunId: string;
    }[];
}
/** Everything preflight produces before either step's dispatch loop runs. */
export interface PreparedRuntimeActionDispatch {
    readonly adapter: ChannelAdapter;
    readonly adapterCtx: ChannelAdapterContext;
    readonly auth: Parameters<typeof buildSubagentRunInput>[0]["auth"];
    readonly batch: NonNullable<ReturnType<typeof getPendingRuntimeActionBatch>>;
    readonly bundle: CompiledBundle;
    readonly capabilities: Parameters<typeof buildSubagentRunInput>[0]["capabilities"];
    readonly channelMetadata: Parameters<typeof buildSubagentRunInput>[0]["channelMetadata"];
    /**
     * Number of freshly started local subagents in the plan. The parent's
     * remaining token quota is split across these, the children that
     * actually receive an enforced cap: continuations already run under
     * their own budget, and remote agents run on their own deployment
     * under their own limits, so neither dilutes the local shares.
     */
    readonly fanoutSize: number;
    readonly initiatorAuth: Parameters<typeof buildSubagentRunInput>[0]["initiatorAuth"];
    readonly parentTraceContext: Parameters<typeof buildSubagentRunInput>[0]["parentTraceContext"];
    readonly sandboxSessionId: string;
    readonly serializedContext: Record<string, unknown>;
    readonly plan: readonly DispatchPlanEntry[];
    readonly session: RuntimeSession;
    readonly turnOriginAuth: Parameters<typeof buildSubagentRunInput>[0]["auth"] | undefined;
}
/**
 * Runs every dispatch precondition that may throw — durable reads, context
 * deserialization, handle-store validation, and batch planning — before
 * the caller acquires the parent stream writer, so a preflight failure
 * never leaks the writer lock. Returns undefined when no actions are
 * pending.
 */
export declare function prepareRuntimeActionDispatch(input: {
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
    /**
     * Classify task-control calls as
     * task-control plan entries. Only task mode plans them; in plain mode
     * those calls fail as unsupported batch actions.
     */
    readonly taskControls: boolean;
}): Promise<PreparedRuntimeActionDispatch | undefined>;
/**
 * Emits the parent `subagent.called` control-plane event for one adopted
 * child. Emission is observability, not control flow: a failure is logged
 * and swallowed, because a throw escaping the dispatch loop would durably
 * replay the step and re-dispatch children that already started.
 */
export declare function emitSubagentCalled(input: {
    readonly adapter: ChannelAdapter;
    readonly adapterCtx: ChannelAdapterContext;
    readonly batchEvent: {
        readonly sequence: number;
        readonly turnId: string;
    };
    readonly entry: Extract<DispatchPlanEntry, {
        readonly kind: "resume" | "start";
    }>;
    readonly outcome: Extract<DispatchOutcome, {
        readonly kind: "called";
    }>;
    readonly sessionId: string;
    readonly writer: WritableStreamDefaultWriter<Uint8Array>;
}): Promise<void>;
/** Starts one planned fresh child against its local or remote target. */
export declare function startSubagent(input: {
    readonly auth: Parameters<typeof buildSubagentRunInput>[0]["auth"];
    readonly batchEvent: {
        readonly sequence: number;
        readonly turnId: string;
    };
    readonly bundle: CompiledBundle;
    readonly callbackBaseUrl: string | undefined;
    readonly capabilities: Parameters<typeof buildSubagentRunInput>[0]["capabilities"];
    readonly channelMetadata: Parameters<typeof buildSubagentRunInput>[0]["channelMetadata"];
    readonly currentSession: RuntimeSession;
    readonly fanoutSize: number;
    readonly initiatorAuth: Parameters<typeof buildSubagentRunInput>[0]["initiatorAuth"];
    readonly parentContinuationToken: string | undefined;
    readonly parentTraceContext: Parameters<typeof buildSubagentRunInput>[0]["parentTraceContext"];
    readonly persistentSessions: boolean;
    readonly sandboxSessionId: string;
    readonly serializedContext: Record<string, unknown>;
    readonly session: RuntimeSession;
    readonly taskOwned: boolean;
    readonly target: DispatchStartTarget;
}): Promise<DispatchOutcome>;
export {};
