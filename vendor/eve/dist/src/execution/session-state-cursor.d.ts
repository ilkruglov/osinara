import type { DurableSessionState } from "#execution/durable-session-store.js";
/** A durable-state transition; absent fields keep the cursor's current value. */
export interface SessionStateTransition {
    readonly serializedContext?: Record<string, unknown>;
    readonly sessionState?: DurableSessionState;
}
/**
 * Owns the mutable serialized-context / session-state pair that durable
 * steps thread through a run. Holders adopt each step's transition instead
 * of rebinding both values by hand at every callsite.
 */
export declare class SessionStateCursor {
    private currentSerializedContext;
    private currentSessionState;
    constructor(input: {
        readonly serializedContext: Record<string, unknown>;
        readonly sessionState: DurableSessionState;
    });
    /** Latest adopted serialized runtime context. */
    get serializedContext(): Record<string, unknown>;
    /** Latest adopted durable session state. */
    get sessionState(): DurableSessionState;
    /** Adopts a state transition; fields a step did not change carry forward. */
    adoptState(transition: SessionStateTransition): void;
}
