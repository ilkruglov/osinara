import type { UserContent } from "ai";
import type { ChannelAdapter } from "#channel/adapter.js";
import { type ChannelDeliverySource } from "#channel/delivery-metadata.js";
import type { SendPayload } from "#channel/routes.js";
import { type Session } from "#channel/session.js";
import type { CancelTurnResult, ClearSessionResult, CompactSessionResult, ResetSessionResult, Runtime, SessionAuthContext, SessionCallback, TurnPolicy } from "#channel/types.js";
import type { RunMode } from "#shared/run-mode.js";
interface BaseChannelAddressDeliveryOptions {
    readonly auth: SessionAuthContext | null;
    readonly callback?: SessionCallback;
    readonly initiatorAuth?: SessionAuthContext | null;
    readonly mode?: RunMode;
    readonly title?: string;
    readonly turnPolicy?: TurnPolicy;
}
/** Delivery options for a channel address whose continuation token is already bound. */
export type ChannelAddressDeliveryOptions<TState = undefined> = [TState] extends [undefined] ? BaseChannelAddressDeliveryOptions : BaseChannelAddressDeliveryOptions & {
    readonly state?: Partial<TState>;
};
/**
 * Dynamic handle for whichever durable session currently owns one channel-local address.
 * Only {@link send} may create a session when the address is unowned.
 */
export interface ChannelAddress<TState = undefined> {
    readonly continuationToken: string;
    deliver(input: SendPayload, options: ChannelAddressDeliveryOptions<TState>): Promise<Session>;
    send(message: string | UserContent, options: ChannelAddressDeliveryOptions<TState>): Promise<Session>;
    respond(inputResponses: SendPayload["inputResponses"], options: ChannelAddressDeliveryOptions<TState>): Promise<Session>;
    cancel(options?: {
        readonly turnId?: string;
    }): Promise<CancelTurnResult>;
    compact(): Promise<CompactSessionResult>;
    clear(): Promise<ClearSessionResult>;
    reset(options?: {
        readonly reason?: string;
    }): Promise<ResetSessionResult>;
    resolveSession(): Promise<Session | undefined>;
}
/** Factory for binding a route-local continuation token to a {@link ChannelAddress}. */
export type ChannelAddressFn<TState = undefined> = (continuationToken: string) => ChannelAddress<TState>;
/** Creates one channel address backed by the runtime's continuation dispatch primitive. */
export declare function createChannelAddress<TState = undefined>(input: {
    readonly adapter: ChannelAdapter<any>;
    readonly channelName: string;
    readonly continuationToken: string;
    readonly metadata?: ChannelDeliverySource;
    readonly runtime: Runtime;
    readonly turnPolicy?: TurnPolicy;
}): ChannelAddress<TState>;
/** Builds a request-scoped factory for channel addresses on one authored channel. */
export declare function createChannelAddressFn<TState = undefined>(input: {
    readonly adapter: ChannelAdapter<any>;
    readonly channelName: string;
    readonly metadata?: ChannelDeliverySource;
    readonly runtime: Runtime;
    readonly turnPolicy?: TurnPolicy;
}): ChannelAddressFn<TState>;
export {};
