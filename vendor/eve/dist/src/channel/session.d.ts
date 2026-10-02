import type { ContextAccessor } from "#context/key.js";
import { type ChannelDeliverySource } from "#channel/delivery-metadata.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type { UserContent } from "ai";
import type { CancelTurnResult, ClearSessionResult, CompactSessionResult, ResetSessionResult, Runtime, SessionAuthContext, SessionCallback, SessionSendCommandResult, TurnPolicy, TurnCaller } from "#channel/types.js";
import type { SessionAuth } from "#context/keys.js";
import type { InputResponse } from "#runtime/input/types.js";
import type { JsonObject } from "#shared/json.js";
/** Immutable-ID handle for one exact durable session. */
export interface Session {
    readonly id: string;
    /** Sends a message to this exact session ID without creating or following a replacement. */
    send(message: string | UserContent, options: SessionSendOptions): Promise<SessionSendCommandResult>;
    /** Answers pending input requests on this exact session ID. */
    respond(inputResponses: readonly InputResponse[], options: SessionRespondOptions): Promise<SessionSendCommandResult>;
    /** Requests cancellation of this exact session's active turn or one owned task. */
    cancel(options?: {
        taskId?: string;
        turnId?: string;
    }): Promise<CancelTurnResult>;
    /** Queues compaction on this exact session ID. */
    compact(): Promise<CompactSessionResult>;
    /** Queues a context clear on this exact session ID. */
    clear(): Promise<ClearSessionResult>;
    /** Terminally retires this exact session ID. */
    reset(options?: {
        reason?: string;
    }): Promise<ResetSessionResult>;
    getEventStream(options?: {
        startIndex?: number;
    }): Promise<ReadableStream<MessageStreamEvent>>;
    getStreamTailIndex(): Promise<number>;
}
interface SessionDeliveryOptions {
    readonly auth: SessionAuthContext | null;
    /** Public callback destination for a delegated continuation turn. */
    readonly callback?: SessionCallback;
    readonly context?: readonly string[];
    readonly outputSchema?: JsonObject;
}
/** Options for sending a message through a fixed session handle. */
export type SessionSendOptions = SessionDeliveryOptions & {
    readonly turnPolicy?: TurnPolicy;
};
/** Options for answering pending input requests through a fixed session handle. */
export type SessionRespondOptions = SessionDeliveryOptions;
/**
 * Live handle to the current session, exposed on `ctx.session` to
 * `deliver` and event handlers. The framework hydrates the read-only
 * fields from the active context at step start. A write through
 * `continuation.rekey()` updates the context so the
 * runtime can re-key the parked workflow hook at the next step boundary.
 */
export interface SessionHandle {
    readonly id: string;
    readonly auth: SessionAuth;
    readonly continuation?: {
        readonly token: string;
        rekey(rawToken: string): void;
    };
}
export declare function createSession(id: string, runtime: Runtime, metadata?: Partial<ChannelDeliverySource> & {
    readonly turnPolicy?: TurnPolicy;
}): Session;
/** Builds an I/O-free factory for fixed session-ID handles. */
export declare function createAttachSessionFn(runtime: Runtime, metadata?: Partial<ChannelDeliverySource> & {
    readonly turnPolicy?: TurnPolicy;
}): (sessionId: string) => Session;
/**
 * Builds a live {@link SessionHandle} backed by the active context
 * accessor. Read-only fields resolve through getters so they reflect
 * any updates made by other handlers within the same step (e.g. the
 * `deliver` hook seeding `AuthKey` before an event handler reads
 * `session.auth`).
 *
 * Used by {@link buildAdapterContext} to populate `ctx.session` on
 * every adapter handler invocation.
 */
export declare function buildSessionHandle(accessor: ContextAccessor): SessionHandle;
/** @internal Converts validated public callback metadata into runtime turn routing. */
export declare function sessionCallbackToTurnCaller(callback: SessionCallback | undefined): TurnCaller | undefined;
export {};
