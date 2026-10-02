import type { SessionAuthContext } from "#channel/types.js";
import { type TaskView } from "#tasks/types.js";
/** Input for one durable task run. */
export interface TaskRunWorkflowInput {
    /** Private task inbox token; a routing credential, never model-visible. */
    readonly taskInboxToken: string;
    /** The creation view, normally `working`. */
    readonly initialView: TaskView;
    /** Parent session delivery token used to wake the task's owning parent. */
    readonly parentContinuationToken: string;
    /** Additive for old in-flight task runs; absence is restored as fail-closed null auth. */
    readonly parentAuth?: SessionAuthContext | null;
}
/**
 * The durable task run: single writer for one task's lifecycle.
 *
 * Consumes commands and child wire payloads over its private hook,
 * applies the pure transition function, and appends a full `TaskView`
 * per accepted command to its `eve.task` run stream. Competing
 * completion, cancellation, and input transitions serialize here;
 * rejected commands (for example a late child result after `cancelled`)
 * change nothing.
 *
 * Wake policy: a transition into a ready status — terminal or
 * `input_required` — and an explicit child `task_update` deliver a
 * framework notification to the parent session. A parked parent starts
 * a turn; an active turn observes the delivery at its next safe boundary.
 *
 * The run ends when the task reaches a terminal status. Its view
 * stream stays readable, so terminal tasks remain peekable; the
 * disposed hook makes any later command fail loudly instead of queueing
 * against a finished task.
 */
export declare function taskRunWorkflow(input: TaskRunWorkflowInput): Promise<void>;
