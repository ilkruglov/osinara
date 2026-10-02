import { type DispatchOutcome, type RuntimeAgentHandleAction, type RuntimeSession } from "#execution/agent-handle-dispatch.js";
import { settleDelegatedDispatch, type DelegatedTask } from "#execution/tasks/parent/delegate.js";
import { describeTaskAgent } from "#execution/tasks/parent/agent-identity.js";
import type { RuntimeSubagentDispatchFailure } from "#runtime/actions/types.js";
export type PersistedContinuationTask = Awaited<ReturnType<typeof settleDelegatedDispatch>>;
/** Describes task identity from the stored address when continuing an agent. */
export declare function describeTaskDispatch(input: {
    readonly action: RuntimeAgentHandleAction;
    readonly agentId: string | undefined;
    readonly parentSessionId: string;
    readonly parentTurnId: string;
    readonly session: RuntimeSession;
}): ReturnType<typeof describeTaskAgent>;
export declare function checkTaskContinuationAvailability(input: {
    readonly action: RuntimeAgentHandleAction;
    readonly agentId: string;
    readonly parentStepIndex: number;
    readonly parentTurnId: string;
    readonly session: RuntimeSession;
}): Promise<RuntimeSubagentDispatchFailure | undefined>;
/**
 * Persists the task's ownership and routing entry in the parent session's
 * `eve.tasks` index and creates its parked tool-call receipt before dispatch.
 */
export declare function persistContinuationTaskInParentSession(input: {
    readonly action: RuntimeAgentHandleAction;
    readonly agentId: string;
    readonly delegated: DelegatedTask;
    readonly session: RuntimeSession;
}): Promise<PersistedContinuationTask | undefined>;
export declare function settleTaskDispatchError(input: {
    readonly delegated: DelegatedTask;
    readonly outcome: Extract<DispatchOutcome, {
        readonly kind: "error";
    }>;
    readonly persisted: PersistedContinuationTask | undefined;
}): Promise<RuntimeSubagentDispatchFailure>;
