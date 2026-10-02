import type { DeliverHookPayload } from "#channel/types.js";
import type { TurnControlPayload } from "#execution/turn-control-protocol.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { TurnStepInput, TurnStepPayload } from "#execution/durable-session-migrations/turn-workflow.js";
import { SessionStateCursor } from "#execution/session-state-cursor.js";
import type { SettledTurn } from "#harness/types.js";
import type { TokenUsage } from "#shared/token-usage.js";
interface TurnTransition {
    readonly serializedContext?: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
}
type TurnTerminalAction = {
    readonly isError?: boolean;
    readonly kind: "done";
    readonly output: unknown;
    readonly usage?: TokenUsage;
    readonly usageDelta?: TokenUsage;
} | {
    readonly authorizationAttemptIds?: readonly string[];
    readonly authorizationNames?: readonly string[];
    readonly cancelled?: true;
    readonly kind: "park";
    readonly settled?: SettledTurn;
};
/** Owns the mutable durable state cursor for one active turn workflow. */
export declare class TurnExecutionCursor extends SessionStateCursor {
    readonly controlToken: string;
    readonly parentWritable: WritableStream<Uint8Array>;
    private lastReportedContinuationToken;
    constructor(input: {
        readonly controlToken: string;
        readonly parentWritable: WritableStream<Uint8Array>;
        readonly serializedContext: Record<string, unknown>;
        readonly sessionState: DurableSessionState;
    });
    /** Adopts a state transition and reports any continuation-token change once. */
    adopt(transition: TurnTransition): Promise<void>;
    /** Builds the next atomic turn-step input from the cursor's current state. */
    createStepInput(input: TurnStepPayload | undefined, abortSignal?: AbortSignal): TurnStepInput;
    /**
     * Adopts a terminal turn transition and publishes it as the turn result.
     * The result already carries the final session state, so no separate
     * continuation-token update is sent.
     */
    finish(transition: TurnTransition, action: TurnTerminalAction, bufferedDeliveries: readonly DeliverHookPayload[]): Promise<void>;
    /** Sends one control payload to the session driver. */
    send(payload: TurnControlPayload): Promise<void>;
}
export {};
