/**
 * Delegation policy for the subagent dispatch path: derives task identity,
 * builds metadata and the parked-tool-call receipt, records the session
 * index, and defines failure semantics for an unacknowledged dispatch.
 * Task-run transport (start/command/view) lives in `run-parent.ts`, which
 * this module composes and which other non-delegation callers share.
 */
import type { RuntimeSession } from "#execution/agent-handle-dispatch.js";
import type { RuntimeSubagentChildResult } from "#runtime/actions/types.js";
import type { JsonValue } from "#shared/json.js";
import type { SessionAuthContext } from "#channel/types.js";
import { type TaskMetadata } from "#tasks/types.js";
/** A prepared delegated task: identity plus its started durable run. */
export interface DelegatedTask {
    readonly taskInboxToken: string;
    readonly createdByStepIndex?: number;
    readonly createdByTurnId: string;
    readonly metadata: TaskMetadata;
    readonly operationId: string;
    readonly taskId: string;
    readonly taskRunId: string;
}
/**
 * Creates the durable task record for one delegated subagent call,
 * before the child dispatch side effect. The task must exist first so
 * a fast child always finds a live command hook; a duplicate replay
 * re-derives the same token and the loser exits on the hook claim.
 */
export declare function beginDelegatedTask(input: {
    readonly auth: SessionAuthContext | null;
    readonly agentId: string;
    readonly callId: string;
    readonly mode: "local" | "remote";
    readonly name: string;
    readonly parentSessionId: string;
    readonly parentStepIndex?: number;
    readonly parentTurnId: string;
    readonly session: RuntimeSession;
}): Promise<DelegatedTask>;
/**
 * Settles a delegated dispatch that acknowledged a child: persists the task
 * in the session index and returns the receipt that resolves the originating
 * tool call. Agent identity and routing remain in the persistent address
 * record; task state owns execution availability.
 */
export declare function settleDelegatedDispatch(input: {
    readonly callId: string;
    readonly session: RuntimeSession;
    readonly subagentName: string;
    readonly task: DelegatedTask;
}): Promise<{
    readonly receipt: RuntimeSubagentChildResult;
    readonly session: RuntimeSession;
}>;
/** Releases task events only after the parent session index committed. */
export declare function acknowledgeDelegatedTasksStep(input: {
    readonly tasks: readonly {
        readonly taskInboxToken: string;
        readonly taskId: string;
        readonly taskRunId: string;
    }[];
}): Promise<void>;
/** Fails an indexed task whose child dispatch was definitively rejected. */
export declare function failDelegatedDispatch(input: {
    readonly error: JsonValue;
    readonly task: DelegatedTask;
}): Promise<void>;
/** Silently terminates a task whose child dispatch failed before parent indexing. */
export declare function rejectDelegatedDispatch(input: {
    readonly error: JsonValue;
    readonly task: DelegatedTask;
}): Promise<void>;
