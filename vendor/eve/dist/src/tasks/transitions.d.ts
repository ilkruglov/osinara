import type { TaskCommand, TaskView } from "#tasks/types.js";
/**
 * Outcome of applying one command to a task view.
 *
 * - `accepted`: the state changed; the new view must be appended.
 * - `noop`: the command is recognized and benign (idempotent cancel,
 *   stale answer); nothing changed and nothing is appended.
 * - `rejected`: the command is invalid for the current status; the
 *   reason is diagnostic only.
 */
type TaskTransitionResult = {
    readonly outcome: "accepted";
    readonly view: TaskView;
} | {
    readonly outcome: "noop";
    readonly view: TaskView;
} | {
    readonly outcome: "rejected";
    readonly view: TaskView;
    readonly reason: string;
};
export declare function applyTaskTransition(view: TaskView, command: TaskCommand): TaskTransitionResult;
export {};
