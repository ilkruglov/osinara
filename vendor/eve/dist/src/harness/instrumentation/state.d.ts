import { type JsonValue } from "#shared/json.js";
import type { InstrumentationAttemptScope } from "#harness/instrumentation/lifecycle.js";
export interface InstrumentationStateOwner {
    readonly attemptId?: string;
    readonly sessionId?: string;
    readonly turnId?: string;
}
/**
 * Keeps provider state from an interrupted step's context changes.
 *
 * A cancelled step's context writes are discarded wholesale. Provider state has
 * to be an exception for the same reason eve's own trace state is: the
 * cancellation epilogue still publishes `turn.cancelled`, and a provider that
 * staged something at the start of the operation being cancelled needs it there
 * to close cleanly. Without this, the terminal arrives with an empty slot and
 * whatever the provider opened is never closed.
 */
export declare function preserveSerializedInstrumentationState(original: Record<string, unknown>, interrupted: Record<string, unknown>): Record<string, unknown>;
/** One provider's view of its own state for one operation. */
export interface InstrumentationStateSlot {
    get(): JsonValue | undefined;
    /** Stages a value; `undefined` releases the slot. */
    set(value: JsonValue | undefined): void;
}
export interface InstrumentationStateLease extends InstrumentationStateSlot {
    /** Makes later reads empty and writes no-ops. */
    revoke(): void;
}
/**
 * Scopes state to one provider and one operation.
 *
 * Two providers handling the same event get separate slots, and the same
 * provider gets a separate slot per operation, so neither can read or clobber
 * the other's.
 */
export declare function instrumentationStateSlot(provider: string, idempotencyKey: string, owner?: InstrumentationStateOwner): InstrumentationStateLease;
/** Persists that a provider's start handler timed out for this operation. */
export declare function abandonInstrumentationState(provider: string, idempotencyKey: string, owner?: InstrumentationStateOwner): void;
export declare function isInstrumentationStateAbandoned(provider: string, idempotencyKey: string): boolean;
/** Releases one operation across namespaces, including providers no longer registered. */
export declare function releaseAllInstrumentationState(idempotencyKey: string): void;
/** Releases attempt-owned children across namespaces when their terminals are omitted. */
export declare function releaseAllInstrumentationAttemptState(attemptId: string): void;
export declare function releaseAllInstrumentationTurnState(sessionId: string, turnId?: string): void;
/** Remembers where a durable runtime action originated. */
export declare function rememberInstrumentationActionScope(idempotencyKey: string, scope: InstrumentationAttemptScope): void;
/** Remembers where a durable input request originated. */
export declare function rememberInstrumentationInputScope(idempotencyKey: string, scope: InstrumentationAttemptScope): void;
/** Reads and releases one durable input request's originating scope. */
export declare function takeInstrumentationInputScope(idempotencyKey: string): InstrumentationAttemptScope | undefined;
export interface InstrumentationActionCorrelation {
    readonly idempotencyKey: string;
    readonly scope: InstrumentationAttemptScope;
}
export declare function findInstrumentationActionScopeForCall(sessionId: string, callId: string): InstrumentationActionCorrelation | undefined;
/** Reads and releases one durable runtime action's originating scope. */
export declare function takeInstrumentationActionScopeForCall(sessionId: string, callId: string): InstrumentationActionCorrelation | undefined;
/** Takes every still-open action owned by one session or turn. */
export declare function takeInstrumentationActionScopes(sessionId: string, turnId?: string): readonly InstrumentationActionCorrelation[];
