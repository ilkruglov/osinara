import type { RuntimeSession } from "#execution/agent-handle-dispatch.js";
import { type AgentHandle } from "#harness/handles/store.js";
import type { RuntimeActionResult, RuntimeToolCallActionRequest } from "#runtime/actions/types.js";
import { type SessionTaskIndexEntry } from "#tasks/session-index.js";
import type { TaskView } from "#tasks/types.js";
/**
 * Result and lookup helpers shared by the task-control executors
 * (`task_cancel` in the dispatch module,
 * task controls in their own).
 */
/** Resolves owned index entries, or the ids this session does not own. */
export declare function lookupTaskEntries(session: RuntimeSession, taskIds: readonly string[]): {
    readonly entries: SessionTaskIndexEntry[];
    readonly kind: "found";
} | {
    readonly kind: "unknown";
    readonly unknown: string[];
};
/** Reads the latest view of every entry, defaulting to `working`. */
export declare function readTaskViews(entries: readonly SessionTaskIndexEntry[]): Promise<TaskView[]>;
export declare function readTaskView(entry: SessionTaskIndexEntry): Promise<TaskView>;
/** Finds the persistent address record for one task-owned agent. */
export declare function findTaskAgentAddress(session: RuntimeSession, agentId: string): Extract<AgentHandle, {
    phase: "addressed";
}> | undefined;
/** Returns the one nonterminal task owning an agent, if any. */
export declare function findActiveTaskForAgent(session: RuntimeSession, agentId: string, parentTurnId?: string, parentStepIndex?: number): Promise<{
    readonly entry: SessionTaskIndexEntry;
    readonly view: TaskView;
} | undefined>;
/** One successful task-control result carrying full task views. */
export declare function createTaskViewsResult(action: RuntimeToolCallActionRequest, views: readonly TaskView[]): RuntimeActionResult;
/** One task-control error the model can act on. */
export declare function createTaskControlError(action: RuntimeToolCallActionRequest, message: string): RuntimeActionResult;
/** The ownership error for ids outside this session's task index. */
export declare function createUnknownTasksError(action: RuntimeToolCallActionRequest, unknown: readonly string[]): RuntimeActionResult;
