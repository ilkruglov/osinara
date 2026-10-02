import type { TaskCommand, TaskRunInboundPayload } from "#tasks/types.js";
/**
 * Translates one inbound hook payload into a lifecycle command.
 *
 * Delegated dispatch hands children the task run's hook token, so the
 * payloads that used to resume the parent turn arrive here instead:
 *
 * - a settled child turn (local notification or remote callback)
 *   carries an explicit outcome — its result status decides
 *   `complete`, `fail`, or `cancel`;
 * - a forwarded HITL batch marks the task `input_required` with the
 *   outstanding requests;
 * - `authorization.required` also blocks the task (the child cannot
 *   proceed without the parent's user) under a reserved request id, and
 *   `authorization.completed` clears exactly that id. Authorization
 *   payloads never enter the view — only the fact that the child is
 *   blocked does.
 *
 * `input-response` is deliberately absent: the run must forward the
 * answers to the child before it may record them, so it builds that
 * command itself rather than translating one here.
 *
 * Returns `undefined` for unrecognized payloads, which the run ignores.
 */
export declare function translateTaskInboundPayload(payload: TaskRunInboundPayload): TaskCommand | undefined;
