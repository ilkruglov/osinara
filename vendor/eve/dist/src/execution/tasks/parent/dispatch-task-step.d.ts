/**
 * Task-mode sibling of `dispatchRuntimeActionsStep`, selected by the turn
 * workflow when the agent enables `experimental.tasks`.
 *
 * Same plan → dispatch → emit skeleton, but every delegation is wrapped in
 * the durable task lifecycle: the task record and its inbox token
 * exist *before* the child dispatch side effect (`beginDelegatedTask`),
 * continuations pass the availability check and enter the parent session's
 * task index first, and the task settles against the dispatch outcome.
 * Children report through their task's inbox token rather than the
 * parent turn inbox, and every start dispatches a conversation-mode
 * (persistent) child so the background task stays resumable.
 *
 * Task-control calls (`task_cancel` / `task_update`) execute
 * inline in this step, which holds the session ownership index and world
 * access they need.
 */
import { type RuntimeActionDispatchInput, type RuntimeActionDispatchResult } from "#execution/dispatch-runtime-actions-shared.js";
export declare function dispatchTaskStep(input: RuntimeActionDispatchInput): Promise<RuntimeActionDispatchResult>;
