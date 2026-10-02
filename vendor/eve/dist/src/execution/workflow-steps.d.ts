import type { SettledTurn } from "#harness/types.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { type DurableSessionState } from "#execution/durable-session-store.js";
import type { TurnStepInput } from "#execution/durable-session-migrations/turn-workflow.js";
/**
 * Result of one durable harness step. `cancelled` is returned so workflow-core
 * does not retry it; `park` carries the pending state needed by the next action.
 */
export type DurableStepResult = {
    readonly action: "continue" | "done";
    readonly output?: unknown;
    readonly isError?: boolean;
    /**
     * Optional durable pause for the turn workflow to fulfill before
     * dispatching this result's next action.
     */
    readonly sleepDurationMs?: number;
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
    /** Session-total token usage; set on `done` when the session spent any. */
    readonly usage?: TokenUsage;
    /**
     * Usage the final turn added beyond what earlier settled turns already
     * reported; feeds the terminal `AgentTurnOutcome` for conversation
     * children. Task sessions settle once, so their callers read `usage`.
     */
    readonly usageDelta?: TokenUsage;
} | {
    readonly action: "cancelled";
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
} | {
    readonly action: "park";
    readonly authorizationAttemptIds?: readonly string[];
    readonly authorizationNames?: readonly string[];
    readonly hasPendingAuthorization: boolean;
    readonly hasPendingInputBatch: boolean;
    readonly pendingRuntimeActionKeys?: readonly string[];
    /**
     * Selects the dispatch step for `pendingRuntimeActionKeys`:
     * `dispatchTaskStep` when the agent runs `experimental.tasks`,
     * `dispatchRuntimeActionsStep` otherwise (including when absent).
     */
    readonly tasksEnabled?: boolean;
    readonly sleepDurationMs?: number;
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
    readonly settled?: SettledTurn;
} | {
    readonly action: "dispatch-workflow-runtime-actions";
    readonly pendingRuntimeActionKeys: readonly string[];
    readonly sleepDurationMs?: number;
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
};
export type { TurnStepInput };
/**
 * Runs one atomic harness step inside a durable `"use step"` boundary.
 */
export declare function turnStep(rawInput: TurnStepInput): Promise<DurableStepResult>;
