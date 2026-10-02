import type { AuthorizationRequiredStreamEvent, TurnFailureStreamEvent, UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { InputRequest } from "#runtime/input/types.js";
/** A connection authorization challenge that remains unresolved at a turn boundary. */
export interface PendingAuthorization {
    readonly authorization?: AuthorizationRequiredStreamEvent["data"]["authorization"];
    readonly description: string;
    readonly name: string;
    readonly webhookUrl?: string;
}
/** Canonical projection of the lifecycle state represented by one turn's events. */
export interface TurnEventSummary {
    readonly boundary: UnstampedMessageStreamEvent | undefined;
    readonly failure: TurnFailureStreamEvent | undefined;
    readonly inputRequests: readonly InputRequest[];
    readonly message: string | undefined;
    readonly pendingAuthorizations: readonly PendingAuthorization[];
    readonly status: "completed" | "failed" | "waiting";
}
/** Reduces one turn's protocol events into their client-facing lifecycle state. */
export declare function summarizeTurnEvents(events: readonly UnstampedMessageStreamEvent[]): TurnEventSummary;
/** Collects one segment of an event stream through its current-turn boundary. */
export declare function collectTurnEvents(stream: AsyncIterable<UnstampedMessageStreamEvent>): Promise<readonly UnstampedMessageStreamEvent[]>;
