import { type TurnWorkflowDispatchInput } from "#execution/durable-session-migrations/turn-workflow.js";
/** Starts a per-turn child workflow for the current driver session. */
export declare function dispatchTurnStep(input: TurnWorkflowDispatchInput): Promise<{
    readonly runId: string;
}>;
