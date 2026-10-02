import { type MessageStreamEvent } from "#protocol/message.js";
import type { CancelSessionResult, MessageResult } from "#client/types.js";
/**
 * Internal configuration passed to construct a {@link MessageResponse}.
 */
interface MessageResponseInput {
    readonly cancelTurn: (turnId: string) => Promise<CancelSessionResult>;
    readonly createStream: () => AsyncGenerator<MessageStreamEvent>;
    readonly sessionId: string;
}
/**
 * The response from {@link ClientSession.send}.
 *
 * Like `fetch()`, the response exposes its session ID as soon as the POST
 * completes. Collect the event stream via
 * {@link result} or iterate it with `for await...of`.
 */
export declare class MessageResponse<TOutput = unknown> implements AsyncIterable<MessageStreamEvent> {
    #private;
    /**
     * Session ID assigned by the server.
     */
    readonly sessionId: string;
    /** @internal */
    constructor(input: MessageResponseInput);
    /**
     * Requests cooperative cancellation of this exact turn.
     *
     * The request waits for the response stream to identify the turn when
     * necessary. Continue consuming the stream to observe its durable boundary.
     */
    cancel(): Promise<CancelSessionResult>;
    /**
     * Consumes the full event stream and returns the aggregated
     * {@link MessageResult}.
     */
    result(): Promise<MessageResult<TOutput>>;
    /**
     * Yields stream events one at a time.
     *
     * Each response can only be consumed once.
     */
    [Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent>;
}
export {};
