import type { DeliverHookPayload, DeliverPayload, SessionAuthContext } from "#channel/types.js";
import { type DurableSessionState } from "#execution/durable-session-store.js";
export type RoutedDeliverResult = {
    readonly kind: "cancel-turn";
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
} | {
    readonly kind: "continue";
    readonly remainder: DeliverHookPayload | undefined;
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
};
type LegacyRoutedDeliverResult = {
    readonly kind: "cancel-turn";
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
} | {
    readonly kind: "continue";
    readonly remainder: DeliverPayload | undefined;
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
};
/** Splits an envelope and validates task routes before forwarding descendant input. */
export declare function routeProxiedDeliverStep(input: {
    readonly delivery: DeliverHookPayload;
    readonly parentWritable: WritableStream<Uint8Array>;
    readonly serializedContext?: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
}): Promise<RoutedDeliverResult>;
export declare function routeProxiedDeliverStep(input: {
    readonly auth?: SessionAuthContext | null;
    readonly parentWritable: WritableStream<Uint8Array>;
    readonly payload: DeliverPayload;
    readonly serializedContext?: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
}): Promise<LegacyRoutedDeliverResult>;
export {};
