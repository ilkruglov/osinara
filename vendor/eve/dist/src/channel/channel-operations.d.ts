import type { UserContent } from "ai";
import type { ChannelAdapter } from "#channel/adapter.js";
import type { ChannelDeliverySource } from "#channel/delivery-metadata.js";
import { type ChannelAddressDeliveryOptions } from "#channel/channel-address.js";
import type { SendPayload } from "#channel/routes.js";
import type { Session } from "#channel/session.js";
import type { CancelTurnResult, ClearSessionResult, CompactSessionResult, ResetSessionResult, Runtime, SessionAuthContext, SessionCallback, TurnPolicy } from "#channel/types.js";
import type { InputResponse } from "#runtime/input/types.js";
import type { JsonObject } from "#shared/json.js";
import type { RunMode } from "#shared/run-mode.js";
interface BaseChannelSendOptions {
    readonly auth: SessionAuthContext | null;
    readonly callback?: SessionCallback;
    readonly context?: readonly string[];
    readonly initiatorAuth?: SessionAuthContext | null;
    readonly mode?: RunMode;
    readonly outputSchema?: JsonObject;
    readonly title?: string;
    readonly turnPolicy?: TurnPolicy;
}
/** Options for sending a message from a channel-local continuation address. */
export type ChannelSendOptions<TState = undefined> = [TState] extends [undefined] ? BaseChannelSendOptions : BaseChannelSendOptions & {
    readonly state: TState;
};
interface BaseChannelRespondOptions<TState = undefined> {
    readonly auth: SessionAuthContext | null;
    readonly context?: readonly string[];
    readonly outputSchema?: JsonObject;
    readonly state?: Partial<TState>;
}
/** Options for answering pending input requests at an existing continuation address. */
export type ChannelRespondOptions<TState = undefined> = BaseChannelRespondOptions<TState>;
/** Dynamic handle for whichever session currently owns one channel-local address. */
export interface ChannelSource<TState = undefined> {
    /** Starts or resumes a turn with a user message. May create a session. */
    send(message: string | UserContent, options: ChannelSendOptions<TState>): Promise<Session>;
    /** Answers pending input requests. Never creates a session. */
    respond(inputResponses: readonly InputResponse[], options: ChannelRespondOptions<TState>): Promise<Session>;
    /** Cooperatively cancels the active turn without creating a session. */
    cancel(options?: {
        readonly turnId?: string;
    }): Promise<CancelTurnResult>;
    /** Queues context compaction without creating a session. */
    compact(): Promise<CompactSessionResult>;
    /** Clears model-message history without creating a session. */
    clear(): Promise<ClearSessionResult>;
    /** Retires the current owner without creating a replacement. */
    reset(options?: {
        readonly reason?: string;
    }): Promise<ResetSessionResult>;
}
/** Binds a raw channel-local continuation address to its current-owner operations. */
export type ChannelFrom<TState = undefined> = (address: string) => ChannelSource<TState>;
/** Snapshots the session currently owning a channel-local continuation address. */
export type ChannelResolveSession = (address: string) => Promise<Session | undefined>;
/** Continuation operations passed to an authored channel's proactive `receive` hook. */
export interface ChannelReceiveContext<TState = undefined> {
    readonly from: ChannelFrom<TState>;
    readonly resolveSession: ChannelResolveSession;
}
export declare const INTERNAL_CHANNEL_DELIVER: unique symbol;
/** @internal Permissive transport delivery retained below public authoring surfaces. */
export interface InternalChannelSource<TState = undefined> extends ChannelSource<TState> {
    [INTERNAL_CHANNEL_DELIVER](payload: SendPayload, options: ChannelAddressDeliveryOptions<TState>): Promise<Session>;
}
/** Creates request-scoped channel operations backed by continuation dispatch. */
export declare function createChannelOperations<TState = undefined>(input: {
    readonly adapter: ChannelAdapter<any>;
    readonly channelName: string;
    readonly metadata?: ChannelDeliverySource;
    readonly runtime: Runtime;
    readonly turnPolicy?: TurnPolicy;
}): ChannelReceiveContext<TState>;
export {};
