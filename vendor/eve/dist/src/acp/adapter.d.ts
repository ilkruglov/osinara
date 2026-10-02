import { type AgentContext, type InitializeRequest, type InitializeResponse, type NewSessionRequest, type NewSessionResponse, type PromptRequest, type PromptResponse } from "#compiled/@agentclientprotocol/sdk/index.js";
import type { ClientOptions, SendTurnInput } from "#client/types.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { InputResponse } from "#runtime/input/types.js";
interface AdapterClientSession {
    send(message: SendTurnInput["message"]): Promise<AsyncIterable<HandleMessageStreamEvent>>;
    respond(inputResponses: readonly InputResponse[]): Promise<AsyncIterable<HandleMessageStreamEvent>>;
    cancel(options?: {
        turnId?: string;
    }): Promise<unknown>;
    reset(): Promise<unknown>;
}
interface AdapterClient {
    readonly sessions: {
        create(input: SendTurnInput): Promise<{
            readonly response: AsyncIterable<HandleMessageStreamEvent>;
            readonly session: AdapterClientSession;
        }>;
    };
}
/** Configuration for translating one ACP client connection to an eve server. */
export interface EveAcpAdapterOptions {
    readonly eveVersion: string;
    readonly auth?: ClientOptions["auth"];
    readonly headers?: ClientOptions["headers"];
    readonly serverUrl: string;
    /** Local workspace root to enforce; omit when connecting to a remote deployment. */
    readonly workspaceRoot?: string;
    /** @internal Test seam for the public eve client boundary. */
    readonly client?: AdapterClient;
}
/**
 * Translates stable ACP v1 sessions onto the public eve HTTP client.
 *
 * The adapter owns only process-local ACP identities. Conversation durability,
 * event cursors, cancellation, and reset behavior remain owned by
 * {@link ClientSession}.
 */
export declare class EveAcpAdapter {
    #private;
    constructor(options: EveAcpAdapterOptions);
    initialize(params: InitializeRequest): InitializeResponse;
    newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
    prompt(params: PromptRequest, client: AgentContext, signal: AbortSignal): Promise<PromptResponse>;
    cancel(sessionId: string): Promise<void>;
    closeSession(sessionId: string): Promise<void>;
    close(): Promise<void>;
}
export {};
