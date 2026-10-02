import type { RuntimeSession } from "#execution/agent-handle-dispatch.js";
import type { ChannelAdapter } from "#channel/adapter.js";
import type { DelegatedTask } from "#execution/tasks/parent/delegate.js";
import type { RuntimeActionRequest, RuntimeActionResult, RuntimeToolCallActionRequest } from "#runtime/actions/types.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { SessionTaskIndexEntry } from "#tasks/session-index.js";
import { type TaskView } from "#tasks/types.js";
/** True for task-control calls dispatched outside the model loop. */
export declare function isTaskControlAction(action: RuntimeActionRequest): action is RuntimeToolCallActionRequest;
/**
 * Executes one task-control call inside the dispatch step, which holds
 * the durable session state (ownership index) and world access the
 * tools need.
 *
 * Returns the current session alongside the action result.
 */
export declare function executeTaskControlAction(input: {
    readonly action: RuntimeToolCallActionRequest;
    readonly adapter?: ChannelAdapter;
    readonly bundle: CompiledBundle;
    readonly parentStepIndex?: number;
    readonly parentTurnId: string;
    readonly serializedContext?: Record<string, unknown>;
    readonly session: RuntimeSession;
}): Promise<{
    readonly result: RuntimeActionResult;
    readonly session: RuntimeSession;
    readonly pendingTask?: DelegatedTask;
}>;
/** Commits task cancellation, then propagates it to the addressed executor. */
export declare function cancelOwnedTask(input: {
    readonly bundle: CompiledBundle;
    readonly entry: SessionTaskIndexEntry;
    readonly session: RuntimeSession;
}): Promise<TaskView>;
