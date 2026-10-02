import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import type { TaskMetadata, TaskView } from "#tasks/types.js";
/**
 * Session-state key for the parent's live-task index.
 *
 * The parent session stores only this index; the mutable task record
 * lives in the dedicated durable task run. The PR #1190 spike found the
 * session-state boundary unworkable for task state itself: session state
 * threads through step results, while callback routes and child
 * executors must update tasks without holding the current snapshot.
 */
export declare const SESSION_TASKS_STATE_KEY = "eve.tasks";
/**
 * One task owned by this session. Immutable model-safe metadata keeps the
 * task-to-agent join available before the task run publishes its first view.
 *
 * `taskInboxToken` is the private routing credential for the task run's
 * inbound hook. It must never render into model context, history, task
 * views, or compaction summaries — the model addresses tasks by
 * `taskId` only, and lookup verifies ownership through this index.
 */
export interface SessionTaskIndexEntry {
    readonly taskId: string;
    readonly taskRunId: string;
    /** Immutable fallback once the owning workflow run expires. */
    readonly terminalView?: TaskView;
    readonly taskInboxToken: string;
    readonly createdByStepIndex?: number;
    readonly createdByTurnId: string;
    readonly metadata: TaskMetadata;
    readonly operationId: string;
}
/**
 * Reads and validates the task index from session state.
 *
 * A present but invalid index throws: treating corruption as absence
 * would silently orphan every live task's routing credential.
 */
export declare function getSessionTaskIndex(state: SessionStateMap | undefined): readonly SessionTaskIndexEntry[];
/** Caches one terminal view beside its task-run address. */
export declare function cacheTerminalTaskView(state: SessionStateMap | undefined, view: TaskView): SessionStateMap | undefined;
/** Finds one owned task; `undefined` enforces parent-session ownership. */
export declare function findSessionTaskEntry(state: SessionStateMap | undefined, taskId: string): SessionTaskIndexEntry | undefined;
/**
 * Records one task, replacing any entry with the same id so replayed
 * creation for the same originating call stays idempotent.
 */
export declare function recordSessionTask(session: HarnessSession, entry: SessionTaskIndexEntry): HarnessSession;
