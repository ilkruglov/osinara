import { ClientSession, type ClientSessionContext } from "#client/session.js";
import type { MessageResponse } from "#client/message-response.js";
import type { SendTurnInput } from "#client/types.js";
/** Result of explicitly creating an ID-addressed client session. */
export interface CreatedClientSession<TOutput = unknown> {
    readonly response: MessageResponse<TOutput>;
    readonly session: ClientSession;
}
/** Collection surface for explicitly creating or attaching ID-addressed sessions. */
export declare class ClientSessions {
    #private;
    /** @internal */
    constructor(context: ClientSessionContext);
    /** Creates a session immediately and returns its fixed handle plus first-turn response. */
    create<TOutput = unknown>(input: SendTurnInput<TOutput>): Promise<CreatedClientSession<TOutput>>;
    /** Attaches a fixed handle to a known session ID without performing I/O. */
    attach(sessionId: string, options?: {
        readonly streamIndex?: number;
    }): ClientSession;
}
