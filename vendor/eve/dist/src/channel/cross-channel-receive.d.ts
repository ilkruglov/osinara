import type { UserContent } from "ai";
import type { ChannelAdapter } from "#channel/adapter.js";
import { type ChannelReference, type CompiledChannel } from "#channel/compiled-channel.js";
import type { InferReceiveTarget } from "#channel/receive-target.js";
import type { Session } from "#channel/session.js";
import type { Runtime, SessionAuthContext, TurnPolicy } from "#channel/types.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";
/**
 * Options for sending a message to a channel selected with `ctx.to(...)`.
 */
export interface CrossChannelSendOptions {
    readonly auth: SessionAuthContext | null;
    readonly turnPolicy?: TurnPolicy;
}
/** Message delivery bound to one channel-specific proactive target. */
export interface CrossChannelTargetHandle {
    send(message: string | UserContent, options: CrossChannelSendOptions): Promise<Session>;
}
/** Selects another authored channel and one of its proactive targets. */
export type CrossChannelToFn = <TChannel extends ChannelReference<unknown>>(channel: TChannel, target: InferReceiveTarget<TChannel>) => CrossChannelTargetHandle;
/**
 * Channel record consumed by the receiver — keeps the public-facing
 * `definition` reference so callers can identify a target by value
 * (the same module-default they imported in their route file).
 */
export interface CrossChannelTarget {
    readonly name: string;
    readonly definition: CompiledChannel;
    readonly receive?: CompiledChannel["receive"];
    readonly adapter?: ChannelAdapter;
    readonly turnPolicy?: CompiledChannel["turnPolicy"];
}
/**
 * Projects an agent's resolved channels into the receiver-input shape.
 *
 * Framework-internal fetch-only channels carry no `definition` reference
 * and are filtered out at this boundary — only authored channels backed
 * by a `defineChannel` value can be receive targets.
 */
export declare function toCrossChannelTargets(channels: readonly ResolvedChannelDefinition[]): readonly CrossChannelTarget[];
/**
 * Builds the `ctx.to(channel, target)` closure used by route and schedule handlers.
 */
export declare function createCrossChannelToFn(runtime: Runtime, channels: readonly CrossChannelTarget[]): CrossChannelToFn;
interface InvokeChannelReceiveInput {
    readonly runtime: Runtime;
    readonly target: Pick<CrossChannelTarget, "name" | "receive" | "adapter" | "turnPolicy">;
    readonly input: {
        readonly message: string | UserContent;
        readonly target: Readonly<Record<string, unknown>>;
        readonly auth: SessionAuthContext | null;
    };
    readonly turnPolicy?: TurnPolicy;
    readonly describeMissingReceive: () => string;
    readonly describeMissingAdapter: () => string;
}
/**
 * Shared authored `receive(input, ctx)` invocation used by route and schedule delivery.
 */
export declare function invokeChannelReceive(args: InvokeChannelReceiveInput): Promise<Session>;
export {};
