import type { UserContent } from "ai";
import type { ChannelAddressDeliveryOptions } from "#channel/channel-address.js";
import type { SendPayload } from "#channel/routes.js";
import type { SessionAuthContext, TurnPolicy } from "#channel/types.js";
import type { ActionEvent, Adapter, ChatConfig, SerializedThread, Thread, WebhookOptions } from "#compiled/chat/index.js";
import { Chat } from "#compiled/chat/index.js";
import { type Channel, type ChannelEvents, type ChannelContinuationOps, type Session } from "#public/definitions/channel.js";
type ChatSdkAdapters = Record<string, Adapter>;
type ChatSdkSendInput = string | UserContent | SendPayload;
/** Durable Chat SDK thread state plus default-handler streaming bookkeeping. */
export interface ChatSdkChannelState extends Record<string, unknown> {
    thread: SerializedThread | null;
    /** Message id of the in-flight streamed assistant post (edit fallback). */
    anchorMessageId?: string | null;
    /**
     * Whether `adapter.editMessage` works for this session. Set to `false` once
     * an edit throws {@link isNotImplemented}, which disables streaming edits for
     * the rest of the session.
     */
    editSupported?: boolean;
    /** Epoch ms of the last streaming edit, used to throttle edits. */
    lastEditAtMs?: number | null;
    /** Buffered first line of a tool-call message, surfaced as typing status. */
    pendingToolCallMessage?: string | null;
    /** Step index the current stream anchor belongs to (resets per step). */
    streamStepIndex?: number | null;
}
/**
 * Thread selector accepted by `chatSdkChannel().receive`. Pass a serialized
 * Chat SDK thread when possible; `threadId` plus `adapterName` is supported for
 * proactive sends that only have a provider-native thread id.
 */
export interface ChatSdkReceiveTarget {
    readonly adapterName?: string;
    readonly thread?: SerializedThread;
    readonly threadId?: string;
}
/**
 * Channel-owned metadata exposed to eve instrumentation.
 */
export interface ChatSdkInstrumentationMetadata extends Record<string, unknown> {
    readonly adapterName: string | null;
    readonly channelId: string | null;
    readonly isDM: boolean | null;
    readonly threadId: string | null;
}
/**
 * Per-session context passed to `chatSdkChannel({ events })` handlers. `thread`
 * is rebuilt from persisted channel state using the configured Chat SDK
 * adapter, so default handlers can post back to the originating chat thread.
 */
export interface ChatSdkChannelContext<TAdapters extends ChatSdkAdapters = ChatSdkAdapters> {
    readonly bot: Chat<TAdapters>;
    readonly thread: Thread | null;
    state: ChatSdkChannelState;
    /** Whether streamed deltas are delivered via a post+edit fallback. */
    readonly streaming: boolean;
    /** Minimum interval between streaming edits, in ms. */
    readonly streamingEditIntervalMs: number;
}
/** Event-handler context for `chatSdkChannel`, including continuation routing. */
export interface ChatSdkEventContext<TAdapters extends ChatSdkAdapters = ChatSdkAdapters> extends ChatSdkChannelContext<TAdapters>, ChannelContinuationOps {
}
/**
 * Per-event handlers for `chatSdkChannel({ events })`. Each supplied handler
 * replaces the built-in default for that event.
 */
export type ChatSdkChannelEvents<TAdapters extends ChatSdkAdapters = ChatSdkAdapters> = ChannelEvents<ChatSdkChannelContext<TAdapters>>;
/**
 * Options for `bridge.send(...)` inside Chat SDK handlers. The `thread`
 * determines the eve continuation token and the persisted channel state.
 */
export interface ChatSdkSendOptions {
    readonly auth?: SessionAuthContext | null;
    readonly callback?: ChannelAddressDeliveryOptions<ChatSdkChannelState>["callback"];
    readonly mode?: ChannelAddressDeliveryOptions<ChatSdkChannelState>["mode"];
    readonly thread: SerializedThread | Thread | string;
    readonly title?: string;
    /**
     * Controls how this input interacts with an active eve turn on the same
     * thread. Defaults to `"steer"`.
     */
    readonly turnPolicy?: TurnPolicy;
    /**
     * Required when `thread` is a string that does not include the Chat SDK
     * adapter prefix. Prefer passing the `Thread` object from the Chat SDK handler
     * when possible.
     */
    readonly adapterName?: string;
}
/**
 * Configuration for {@link chatSdkChannel}. It accepts normal Chat SDK
 * `ChatConfig` fields, plus eve route and event settings.
 */
export interface ChatSdkChannelConfig<TAdapters extends ChatSdkAdapters = ChatSdkAdapters> extends Omit<ChatConfig<TAdapters>, "adapters"> {
    /** Map of Chat SDK adapter name to adapter instance. */
    readonly adapters: TAdapters;
    /**
     * Base route for generated adapter webhooks. Defaults to `/eve/v1`, so an
     * adapter named `slack` mounts at `/eve/v1/slack`.
     */
    readonly route?: string;
    /**
     * Per-adapter route overrides. Use when a provider requires a fixed webhook
     * URL or when migrating an existing endpoint without changing provider
     * settings.
     */
    readonly routes?: Partial<Record<Extract<keyof TAdapters, string>, string>>;
    /** Policy for accepted messages that arrive while a turn is active. */
    readonly turnPolicy?: TurnPolicy;
    /** Extra Chat SDK webhook options. eve owns `waitUntil`. */
    readonly webhook?: Omit<WebhookOptions, "waitUntil">;
    /** Optional eve event handlers. Supplied handlers replace built-in defaults. */
    readonly events?: ChatSdkChannelEvents<TAdapters>;
    /**
     * Prefix for default eve HITL button action ids. Change this if your Chat SDK
     * app already uses the `eve_input:` prefix.
     */
    readonly inputActionPrefix?: string;
    /**
     * Auth resolver for default HITL button clicks. Defaults to `null`; provide a
     * resolver when continued sessions should keep user or tenant auth.
     */
    readonly resolveInputAuth?: (event: ActionEvent) => SessionAuthContext | null | Promise<SessionAuthContext | null>;
    /**
     * Whether the default handlers stream assistant output by posting an initial
     * message and editing it as deltas arrive. Defaults to `true`. Set to `false`
     * for adapters that only deliver a single message per turn (e.g. email), so
     * replies post once on completion.
     */
    readonly streaming?: boolean;
    /**
     * Minimum interval between streaming edits, in ms. Defaults to `1000`. Only
     * used when `streaming` is enabled and the adapter supports editing.
     */
    readonly streamingEditIntervalMs?: number;
}
/** Concrete channel value returned on `bridge.channel`. */
export interface ChatSdkChannel extends Channel<ChatSdkChannelState, ChatSdkReceiveTarget, ChatSdkInstrumentationMetadata> {
}
/**
 * Return value of {@link chatSdkChannel}. Export `channel` from
 * `agent/channels/<name>.ts`, then register handlers on `bot` and call `send`
 * from those handlers to hand work to eve.
 */
export interface ChatSdkChannelBridge<TAdapters extends ChatSdkAdapters = ChatSdkAdapters> {
    readonly bot: Chat<TAdapters>;
    readonly channel: ChatSdkChannel;
    /**
     * Starts or resumes an eve session from inside a Chat SDK webhook handler.
     * Use `channel.receive(...)` for proactive sends that are not handling an
     * inbound Chat SDK webhook.
     */
    send(input: ChatSdkSendInput, options: ChatSdkSendOptions): Promise<Session>;
}
/**
 * Creates an eve channel backed by one Chat SDK runtime and its adapters.
 *
 * @example
 * ```ts
 * import { createSlackAdapter } from "@chat-adapter/slack";
 * import { createMemoryState } from "@chat-adapter/state-memory";
 * import { chatSdkChannel } from "eve/channels/chat-sdk";
 *
 * export const { bot, channel, send } = chatSdkChannel({
 *   userName: "acme",
 *   adapters: { slack: createSlackAdapter() },
 *   state: createMemoryState(),
 * });
 *
 * bot.onNewMention(async (thread, message) => {
 *   await send(message.text, { thread });
 * });
 * ```
 */
export declare function chatSdkChannel<TAdapters extends ChatSdkAdapters>(config: ChatSdkChannelConfig<TAdapters>): ChatSdkChannelBridge<TAdapters>;
export {};
