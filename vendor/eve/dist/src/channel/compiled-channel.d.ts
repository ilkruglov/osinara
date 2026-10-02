import type { ChannelAdapter } from "#channel/adapter.js";
import type { UserContent } from "ai";
import type { ChannelReceiveContext } from "#channel/channel-operations.js";
import type { NormalizedChannelCorsOptions } from "#channel/cors.js";
import type { TypedReceiveTarget } from "#channel/receive-target.js";
import type { RouteDefinition } from "#channel/routes.js";
import type { Session } from "#channel/session.js";
import type { SessionAuthContext, TurnPolicy } from "#channel/types.js";
export declare const CHANNEL_SENTINEL: "eve:channel";
/** Structural identity shared by public authored channels and compiled channels. */
export interface ChannelReference<TReceiveTarget = Record<string, unknown>> extends TypedReceiveTarget<TReceiveTarget> {
    readonly __kind: typeof CHANNEL_SENTINEL;
}
export interface CompiledChannel<TState = undefined, TReceiveTarget = Record<string, unknown>, TMetadata extends Record<string, unknown> = Record<string, unknown>> extends ChannelReference<TReceiveTarget> {
    readonly routes: readonly RouteDefinition<TState>[];
    readonly adapter: ChannelAdapter<any>;
    readonly cors?: NormalizedChannelCorsOptions;
    readonly __metadata?: TMetadata;
    readonly receive?: (input: {
        readonly message: string | UserContent;
        readonly target: Readonly<TReceiveTarget>;
        readonly auth: SessionAuthContext | null;
    }, ctx: ChannelReceiveContext<TState>) => Promise<Session>;
    readonly turnPolicy?: TurnPolicy;
}
export declare function isCompiledChannel(value: unknown): value is CompiledChannel;
export declare function getChannelInstrumentationKind(value: unknown): string | undefined;
export declare function setChannelInstrumentationKind(channel: CompiledChannel, kind: string): void;
