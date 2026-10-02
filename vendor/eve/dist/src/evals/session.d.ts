import type { Client } from "#client/client.js";
import type { ClientSession } from "#client/session.js";
import type { CancelSessionResult, ClientSessionState, SendTurnInput, SendTurnOptions } from "#client/types.js";
import type { MessageStreamEvent, RuntimeTraceContext, TurnFailureStreamEvent } from "#protocol/message.js";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import { AssertionCollector } from "#evals/assertions/collector.js";
import type { EveEvalAssertions, EveEvalLiveTurn, EveEvalOutputAssertions, EveEvalSession, EveEvalSessionResult, EveEvalTurn } from "#evals/types.js";
import type { EveEvalInputRequestMatchOptions } from "#evals/match.js";
/**
 * Error thrown by {@link EveEvalTurn.expectOk} when a turn failed.
 */
export declare class EveEvalTurnFailedError extends Error {
    readonly event: (TurnFailureStreamEvent & MessageStreamEvent) | undefined;
    readonly turn: EveEvalTurn;
    constructor(turn: EveEvalTurn);
}
export interface EvalSessionDriver extends EveEvalAssertions, EveEvalOutputAssertions {
}
export interface EvalSessionStartedEvent {
    readonly primary: boolean;
    readonly sessionId: string;
    readonly startedAt: string;
    readonly traceContext: RuntimeTraceContext;
}
export declare class EvalSessionDriver implements EveEvalSession {
    #private;
    constructor(input: {
        readonly client: Client;
        readonly collector: AssertionCollector;
        readonly onSessionStart?: (event: EvalSessionStartedEvent) => void;
        readonly primary: boolean;
        readonly session?: ClientSession;
        readonly signal?: AbortSignal;
    });
    get events(): readonly MessageStreamEvent[];
    get lastTurn(): EveEvalTurn | undefined;
    get pendingInputRequests(): readonly InputRequest[];
    get sessionId(): string | undefined;
    get state(): ClientSessionState | undefined;
    cancel(): Promise<CancelSessionResult>;
    requireInputRequest(filter?: EveEvalInputRequestMatchOptions): InputRequest;
    respond(responses: readonly InputResponse[], options?: SendTurnOptions): Promise<EveEvalTurn>;
    startRespond(responses: readonly InputResponse[], options?: SendTurnOptions): Promise<EveEvalLiveTurn>;
    respondAll(optionId: string): Promise<EveEvalTurn>;
    send(message: SendTurnInput["message"], options?: SendTurnOptions): Promise<EveEvalTurn>;
    start(message: string, options?: SendTurnOptions): Promise<EveEvalLiveTurn>;
    sendFile(text: string, filePath: string, mediaType?: string): Promise<EveEvalTurn>;
    readTurn(options?: {
        readonly startIndex?: number;
    }): Promise<EveEvalTurn>;
    watchTurn(options?: {
        readonly startIndex?: number;
    }, sessionId?: string): EveEvalLiveTurn;
    snapshot(): EveEvalSessionResult;
}
export declare class EvalSessionManager {
    #private;
    constructor(input: {
        readonly client: Client;
        readonly collector?: AssertionCollector;
        readonly onSessionStart?: (event: EvalSessionStartedEvent) => void;
        readonly signal?: AbortSignal;
    });
    get primary(): EvalSessionDriver;
    newSession(): EvalSessionDriver;
    attachSession(sessionId: string, options?: {
        readonly startIndex?: number;
    }): Promise<EvalSessionDriver>;
    watchTurn(sessionId: string, options?: {
        readonly startIndex?: number;
    }): EveEvalLiveTurn;
    snapshots(): readonly EveEvalSessionResult[];
    lastTurnSession(): EvalSessionDriver | undefined;
    hasActivity(): boolean;
}
