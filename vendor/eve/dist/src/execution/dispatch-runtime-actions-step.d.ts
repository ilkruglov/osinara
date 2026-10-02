/**
 * Starts or continues every pending runtime action for the parked parent
 * session, with children reporting straight back to the parent turn via
 * `parentContinuationToken`.
 *
 * The batch is classified into a dispatch plan first (reject / resume /
 * start), then each entry dispatches and emits one
 * parent `subagent.called` control-plane event through a single tail.
 * Every start commits an agent handle (`starting`) before its side effect
 * and confirms it (`running`) once the child reports coordinates, so the
 * returned snapshot-bearing state owns every child it may have created.
 *
 * Agents running `experimental.tasks` never reach this step: the turn
 * workflow selects `dispatchTaskStep`, the task-mode sibling that wraps
 * each dispatch in the delegated-task lifecycle.
 */
import { type RuntimeActionDispatchInput, type RuntimeActionDispatchResult } from "#execution/dispatch-runtime-actions-shared.js";
export declare function dispatchRuntimeActionsStep(input: RuntimeActionDispatchInput): Promise<RuntimeActionDispatchResult>;
