import { type TaskInboundAnswerInput, type TaskInboundAuthorizationEvent, type TaskInboundInputRequest, type TaskInboundUpdate, type TaskView } from "#tasks/types.js";
/**
 * Appends one full task view to the owning task run's `eve.task`
 * stream. Only the task run workflow calls this, which is what makes
 * the run the single writer readers can trust without re-validating.
 */
export declare function appendTaskViewStep(input: {
    readonly view: TaskView;
}): Promise<void>;
/** Re-emits a task-owned child authorization event through the parent channel. */
export declare function wakeTaskAuthorizationParentStep(input: {
    readonly auth: import("#channel/types.js").SessionAuthContext | null;
    readonly request: TaskInboundAuthorizationEvent;
    readonly taskId: string;
    readonly token: string;
}): Promise<void>;
/**
 * Wakes the parent session with a framework task notification.
 *
 * Rides the ordinary session delivery path: a parked parent starts a
 * turn carrying this message, while an active turn observes it at the
 * next safe boundary through the driver's normal delivery routing. A
 * parent whose session already ended is a tolerated no-op.
 */
export declare function wakeTaskParentStep(input: {
    readonly auth: import("#channel/types.js").SessionAuthContext | null;
    readonly token: string;
    readonly view: TaskView;
}): Promise<void>;
/** Forwards a running child's intermediate update to its parent session. */
export declare function wakeTaskUpdateParentStep(input: {
    readonly auth: import("#channel/types.js").SessionAuthContext | null;
    readonly token: string;
    readonly update: TaskInboundUpdate;
    readonly view: TaskView;
}): Promise<void>;
/** Sends an exact local-task HITL batch to the parent's pre-model router. */
export declare function wakeTaskInputRequestParentStep(input: {
    readonly auth: import("#channel/types.js").SessionAuthContext | null;
    readonly request: TaskInboundInputRequest;
    readonly taskId: string;
    readonly token: string;
}): Promise<void>;
/**
 * Forwards answered input to the blocked child.
 *
 * The task run performs this itself so the child unblocks and the
 * view leaves `input_required` under one durable decision. Returns
 * `unreachable` when the child hook is already gone, which leaves the
 * outstanding batch untouched rather than reporting a task as working
 * when nothing received the answer.
 */
export declare function deliverTaskInputResponsesStep(input: {
    readonly answer: TaskInboundAnswerInput;
    readonly requestIds: readonly string[];
}): Promise<"delivered" | "unreachable">;
export declare function formatTaskNotification(view: TaskView): string;
