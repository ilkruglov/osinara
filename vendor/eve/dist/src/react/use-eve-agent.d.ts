import { type EveAgentStoreCallbacks, type EveAgentStoreSnapshot, type EveAgentStoreStatus, type PrepareSend } from "#client/eve-agent-store.js";
import type { EveAgentReducer } from "#client/reducer.js";
import type { ClientSession } from "#client/session.js";
import { type EveMessageData } from "#client/message-reducer.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type { UserContent } from "ai";
import type { CancelSessionResult, ClientAuth, HeadersValue, RespondTurnOptions, SendTurnOptions, ClientSessionState } from "#client/types.js";
export type { PrepareSend };
/**
 * Lifecycle status of an eve agent session.
 *
 * - `"ready"`: idle, accepting a new turn.
 * - `"submitted"`: a turn was sent, no stream events received yet.
 * - `"streaming"`: stream events are arriving for the active turn.
 * - `"error"`: the last turn ended in a terminal failure (see `snapshot.error`).
 */
export type UseEveAgentStatus = EveAgentStoreStatus;
/**
 * Snapshot of an eve agent session: `data` (the reducer projection), `events`
 * (the authoritative server stream), `session` (resumable cursor), `status`,
 * and `error`.
 */
export type UseEveAgentSnapshot<TData> = EveAgentStoreSnapshot<TData>;
/**
 * Snapshot plus commands returned by `useEveAgent`.
 */
export interface UseEveAgentHelpers<TData> extends UseEveAgentSnapshot<TData> {
    /** Requests durable cancellation of the active turn while continuing to receive its events. */
    readonly cancel: () => Promise<CancelSessionResult>;
    /** Resets the session: detaches any local stream, recreates the owned session, and clears events and projected data. */
    readonly reset: () => void;
    /** Sends a message. Rejects if a turn is already in flight. */
    readonly send: <TOutput = unknown>(message: string | UserContent, options?: SendTurnOptions<TOutput>) => Promise<void>;
    /** Answers pending HITL input requests. Rejects if a turn is already in flight. */
    readonly respond: <TOutput = unknown>(inputResponses: Parameters<ClientSession["respond"]>[0], options?: RespondTurnOptions<TOutput>) => Promise<void>;
}
/**
 * Configuration for creating or binding a React eve agent session.
 *
 * Session configuration is read when the hook creates its internal store;
 * remount the component to point at a different host, reducer, or session.
 * Lifecycle callbacks update on every render.
 *
 * For credentials or headers that must change without remounting, pass function
 * values to `auth` or `headers`; the client resolves those before each request.
 */
export interface UseEveAgentOptions<TData> extends EveAgentStoreCallbacks<TData> {
    /**
     * Named agent mounted by a framework integration such as `withEve({ agents })`.
     *
     * `agent: "support"` targets same-origin routes under
     * `/eve/agents/support/eve/v1/...`. Do not combine with `host`.
     */
    readonly agent?: string;
    readonly auth?: ClientAuth;
    readonly headers?: HeadersValue;
    /**
     * Base URL for eve client requests. Do not combine with `agent`.
     *
     * Defaults to same-origin eve routes such as `/eve/v1/...`. Pass a same-origin
     * prefix such as `/api` for an app-owned proxy, or an absolute origin to talk
     * to an eve server directly.
     *
     * @default ""
     */
    readonly host?: string;
    /** Ordered prefix of the session stream used to rehydrate projected state. */
    readonly initialEvents?: readonly MessageStreamEvent[];
    readonly initialSession?: ClientSessionState;
    /**
     * Project submitted user messages before eve confirms them with a
     * `message.received` stream event.
     *
     * Optimistic events are reducer-facing projection events only. They are not
     * exposed through `events`, which remains the authoritative eve stream.
     *
     * @default true
     */
    readonly optimistic?: boolean;
    readonly reducer?: EveAgentReducer<TData>;
    readonly session?: ClientSession;
}
export declare function useEveAgent(options?: UseEveAgentOptions<EveMessageData>): UseEveAgentHelpers<EveMessageData>;
export declare function useEveAgent<TData>(options: UseEveAgentOptions<TData> & {
    readonly reducer: EveAgentReducer<TData>;
}): UseEveAgentHelpers<TData>;
