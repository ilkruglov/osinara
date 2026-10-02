import type { MessageStreamEvent } from "#protocol/message.js";
import { MessageResponse } from "#client/message-response.js";
import type { InputResponse } from "#runtime/input/types.js";
import type { CancelSessionResult, ClearResult, ClientSessionState, CompactResult, ClientRedirectPolicy, RespondTurnOptions, ResetResult, SendTurnInput, SendTurnOptions, SessionSnapshot, StreamOptions } from "#client/types.js";
/**
 * Internal interface that a {@link ClientSession} uses to access client-level
 * configuration without depending on the full {@link Client} class.
 */
export interface ClientSessionContext {
    readonly host: string;
    readonly redirect?: ClientRedirectPolicy;
    resolveHeaders(perRequest?: Readonly<Record<string, string>>): Promise<Headers>;
}
/** One fixed, ID-addressed conversation with an eve agent. */
export declare class ClientSession {
    #private;
    /** @internal */
    constructor(context: ClientSessionContext, state: ClientSessionState);
    /** @internal */
    static create<TOutput = unknown>(context: ClientSessionContext, input: SendTurnInput<TOutput>): Promise<{
        readonly response: MessageResponse<TOutput>;
        readonly session: ClientSession;
    }>;
    /** Current fixed session identity and durable stream cursor. */
    get state(): ClientSessionState;
    /** Reads a finite prefix through the durable tail without advancing this handle. */
    snapshot(options?: {
        readonly signal?: AbortSignal;
    }): Promise<SessionSnapshot>;
    /** Sends a message to this exact session ID. */
    send<TOutput = unknown>(message: SendTurnInput<TOutput>["message"], options?: SendTurnOptions<TOutput>): Promise<MessageResponse<TOutput>>;
    /** Answers pending input requests on this exact session ID. */
    respond<TOutput = unknown>(inputResponses: readonly InputResponse[], options?: RespondTurnOptions<TOutput>): Promise<MessageResponse<TOutput>>;
    /** Requests cooperative cancellation of this session's active turn. */
    cancel(options?: {
        readonly turnId?: string;
    }): Promise<CancelSessionResult>;
    /** Queues removal of this session's durable model-message history. */
    clear(): Promise<ClearResult>;
    /** Queues context compaction without sending model input. */
    compact(): Promise<CompactResult>;
    /** Terminally retires this exact session ID. The handle remains pinned to it. */
    reset(options?: {
        readonly reason?: string;
    }): Promise<ResetResult>;
    /** Opens this session's durable event stream from its stored cursor. */
    stream(options?: StreamOptions): AsyncIterable<MessageStreamEvent>;
}
