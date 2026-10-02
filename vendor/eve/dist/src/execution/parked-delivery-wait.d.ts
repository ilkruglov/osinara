import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import type { SessionCommandInbox } from "#execution/session-command-inbox.js";
import type { SessionStateCursor } from "#execution/session-state-cursor.js";
/** One authorization-callback read surfaced during a parked wait. */
export interface AuthorizationCallbackInstruction {
    readonly kind: "authorization";
    /** True when the authorization hook closed; no further callbacks can arrive. */
    readonly closed: boolean;
    readonly payloads: readonly DeliverPayload[];
}
/** What the parked driver should do with the next session activity. */
export type NextTurnInstruction = {
    readonly kind: "clear";
} | {
    readonly kind: "compact";
} | {
    readonly kind: "expired";
} | {
    readonly kind: "reset";
} | {
    readonly kind: "closed";
} | {
    readonly kind: "cancel-turn";
} | AuthorizationCallbackInstruction | {
    readonly kind: "turn";
    readonly delivery: DeliverHookPayload;
};
/**
 * Awaits the next delivery that requires driver action while the session
 * is parked. Deliveries fully routed to a descendant leave the parent with
 * no turn to run, so this keeps waiting until a delivery produces a parent
 * turn, a cancellation, expiry, or hook closure. The wait is unbounded by
 * design: a parked session lives until something addresses it.
 *
 * With `awaitAuthorizationCallbacks`, the inbox's authorization window stays
 * open for the whole wait — including iterations that consume activity
 * without producing a parent turn (no-op cancels, fully-routed descendant
 * deliveries) — so an open challenge's callback surfaces as an
 * `"authorization"` instruction no matter when it arrives.
 *
 * Routing steps mutate durable state; each transition is adopted into the
 * caller-owned `stateCursor`, so returns carry only the instruction kind.
 */
export declare function nextTurnDelivery(input: {
    readonly awaitAuthorizationCallbacks?: boolean;
    readonly bufferedDeliveries: DeliverHookPayload[];
    readonly bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset">;
    readonly cancelledTaskIds?: Set<string>;
    readonly commandInbox: SessionCommandInbox;
    readonly deferDeliveries?: boolean;
    readonly driverWritable: WritableStream<Uint8Array>;
    readonly seenTaskDeliveries?: Set<string>;
    readonly stateCursor: SessionStateCursor;
}): Promise<NextTurnInstruction>;
