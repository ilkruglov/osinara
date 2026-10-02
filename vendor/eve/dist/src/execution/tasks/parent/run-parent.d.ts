import type { TaskRunWorkflowInput } from "#execution/tasks/child/workflow.js";
import { type TaskCommand, type TaskRunInboundPayload, type TaskView } from "#tasks/types.js";
/**
 * Node-side controls for durable task runs — the generic transport layer.
 * This module only speaks `TaskCommand`/`TaskView`; it knows nothing about
 * subagents, receipts, or the session index. Caller-specific policy (e.g.
 * subagent delegation in `delegate.ts`) composes these primitives.
 *
 * Every export must be called from inside a `"use step"` body; none of
 * these are steps themselves so dispatch and tool steps can compose them
 * inside one durable boundary.
 */
/** Starts the durable run owning one task's lifecycle. */
export declare function startTaskRun(input: TaskRunWorkflowInput): Promise<void>;
/** Resolves the task run that won ownership of one replay-stable command token. */
export declare function waitForTaskCommandOwner(input: {
    readonly taskInboxToken: string;
}): Promise<{
    readonly runId: string;
}>;
/**
 * Submits one command to a task run.
 *
 * `unreachable` means the hook is not resumable — either the run
 * already finished and disposed it (the task is terminal; read the
 * final view) or, right after creation, the freshly started run has
 * not registered it yet. Senders racing that startup window pass
 * `retryUnreachable`; senders addressing an established task treat
 * `unreachable` as the terminal signal.
 */
export declare function sendTaskCommand(input: {
    readonly command: TaskCommand;
    readonly taskInboxToken: string;
    readonly retryUnreachable?: {
        readonly attempts: number;
        readonly delayMs: number;
    };
}): Promise<"delivered" | "unreachable">;
/** Delivers one command and returns the accepting task workflow's run id. */
export declare function sendTaskCommandToOwner(input: {
    readonly command: TaskCommand;
    readonly taskInboxToken: string;
    readonly retryUnreachable?: {
        readonly attempts: number;
        readonly delayMs: number;
    };
}): Promise<{
    readonly runId: string;
} | undefined>;
/**
 * Hands one non-command inbound payload to a task run.
 *
 * Used for payloads the run must act on before it may record them —
 * today only answered input batches, which it forwards to the child
 * first. `unreachable` means the task already finished and disposed its
 * hook, so the payload is stale by definition.
 */
export declare function sendTaskInboundPayload(input: {
    readonly taskInboxToken: string;
    readonly payload: TaskRunInboundPayload;
}): Promise<"delivered" | "unreachable">;
/**
 * Reads the latest view a task run has published, or `undefined`
 * when the run has not committed its first view yet (the caller
 * already holds the creation receipt, which is `working`).
 *
 * Views are trusted without re-validation: the task run is the
 * single writer and every write passed the transition function.
 */
export declare function readLatestTaskView(input: {
    readonly taskRunId: string;
}): Promise<TaskView | undefined>;
