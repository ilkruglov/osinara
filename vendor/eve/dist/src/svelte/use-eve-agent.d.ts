import type { UserContent } from "ai";
import { type EveAgentStoreCallbacks, type EveAgentStoreSnapshot, type EveAgentStoreStatus, type PrepareSend } from "#client/eve-agent-store.js";
import { type EveMessageData } from "#client/message-reducer.js";
import type { EveAgentReducer } from "#client/reducer.js";
import type { ClientSession } from "#client/session.js";
import type { CancelSessionResult, ClientAuth, HeadersValue, RespondTurnOptions, SendTurnOptions, ClientSessionState } from "#client/types.js";
import type { MessageStreamEvent } from "#protocol/message.js";
export type { PrepareSend };
/**
 * Session lifecycle phase: `"ready"` (idle), `"submitted"` (request sent,
 * awaiting the first stream event), `"streaming"` (events arriving), or
 * `"error"`.
 */
export type UseEveAgentStatus = EveAgentStoreStatus;
/**
 * Immutable point-in-time view of an eve agent session: projected `data`, the
 * last `error`, the raw `events` stream, the `session` cursor, and `status`.
 * `useEveAgent` passes this snapshot to the `onFinish` callback.
 */
export type UseEveAgentSnapshot<TData> = EveAgentStoreSnapshot<TData>;
/**
 * Reactive return value from `useEveAgent`.
 *
 * The state properties are Svelte 5 rune-friendly getters. Read them from a
 * template, `$derived`, or `$effect` and Svelte will update when eve streams
 * new events.
 */
export interface UseEveAgentReturn<TData> {
    /** Request durable cancellation of the active turn while continuing to receive its events. */
    readonly cancel: () => Promise<CancelSessionResult>;
    /** Projected state built by reducing every stream event through the reducer. */
    readonly data: TData;
    /** Last transport-level error, or `undefined` when healthy. */
    readonly error: Error | undefined;
    /** Raw server events received during this session (authoritative stream). */
    readonly events: readonly MessageStreamEvent[];
    /** Clear all state and start a new session. */
    readonly reset: () => void;
    /** Send a message with optional turn settings. */
    readonly send: <TOutput = unknown>(message: string | UserContent, options?: SendTurnOptions<TOutput>) => Promise<void>;
    /** Answer pending HITL input requests. */
    readonly respond: <TOutput = unknown>(inputResponses: Parameters<ClientSession["respond"]>[0], options?: RespondTurnOptions<TOutput>) => Promise<void>;
    /** Current session identity and stream cursor. */
    readonly session: ClientSessionState | undefined;
    /** Lifecycle phase: `"ready"` (idle), `"submitted"` (request sent, awaiting first event), `"streaming"` (events arriving), or `"error"`. */
    readonly status: UseEveAgentStatus;
}
/**
 * Configuration for a Svelte eve agent session.
 *
 * Read once when `useEveAgent` creates its store; create a new binding to
 * change host, reducer, or session. To rotate credentials or headers without
 * recreating the binding, pass function values to `auth` or `headers`, which
 * the client resolves before each HTTP request.
 */
export interface UseEveAgentOptions<TData> extends EveAgentStoreCallbacks<TData> {
    /**
     * Named agent mounted by a framework integration such as `withEve({ agents })`.
     *
     * `agent: "support"` targets same-origin routes under
     * `/eve/agents/support/eve/v1/...`. Do not combine with `host`.
     */
    readonly agent?: string;
    /**
     * Credentials for the auto-created session. Pass function values to refresh
     * per request. Ignored when `session` is supplied.
     */
    readonly auth?: ClientAuth;
    /**
     * Custom headers for the auto-created session. Pass a function to resolve
     * fresh values per request. Ignored when `session` is supplied.
     */
    readonly headers?: HeadersValue;
    /**
     * Base URL for eve client requests. Do not combine with `agent`. Empty targets same-origin eve routes
     * such as `/eve/v1/...`; a same-origin prefix like `/api` routes through an
     * app-owned proxy; an absolute origin hits an eve server directly.
     *
     * @default ""
     */
    readonly host?: string;
    /** Ordered prefix of the session stream used to rehydrate projected state. */
    readonly initialEvents?: readonly MessageStreamEvent[];
    /** Seed session identity and stream cursor for resuming a prior conversation. */
    readonly initialSession?: ClientSessionState;
    /**
     * Project submitted user messages before eve confirms them with a
     * `message.received` stream event. Optimistic events are reducer-facing
     * projection only and never appear in `events`, which stays the
     * authoritative eve stream.
     *
     * @default true
     */
    readonly optimistic?: boolean;
    /**
     * Projects stream events into `TData`. Defaults to {@link defaultMessageReducer},
     * which fixes `TData` to {@link EveMessageData}.
     */
    readonly reducer?: EveAgentReducer<TData>;
    /**
     * Pre-built client session to bind to. When omitted, the binding creates its
     * own session from `auth`, `headers`, and `host`.
     */
    readonly session?: ClientSession;
}
export declare function useEveAgent(options?: UseEveAgentOptions<EveMessageData>): UseEveAgentReturn<EveMessageData>;
export declare function useEveAgent<TData>(options: UseEveAgentOptions<TData> & {
    readonly reducer: EveAgentReducer<TData>;
}): UseEveAgentReturn<TData>;
