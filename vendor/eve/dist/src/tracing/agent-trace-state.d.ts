import type { SpanContext } from "#compiled/@opentelemetry/api/index.js";
import type { InstrumentationActionKind, InstrumentationParentLineage, InstrumentationTraceContext, InstrumentationTurnFailedEvent, InstrumentationTurnSettledEvent } from "#harness/instrumentation/lifecycle.js";
/** Sized so an ordinary session stays one trace and only an outsized one rolls. */
export declare const SESSION_WINDOW_TURN_LIMIT = 200;
export interface AgentSessionTraceState {
    readonly agentName?: string;
    readonly channelKind?: string;
    readonly context: SpanContext;
    readonly rootSessionId: string;
    readonly turnsInWindow: number;
    readonly window: number;
}
export interface AgentTurnTraceState {
    readonly context: SpanContext;
    readonly lineage?: InstrumentationParentLineage;
    readonly parentIsRemote?: boolean;
    readonly parentSpanId: string;
    readonly rootSessionId: string;
    readonly sequence: number;
    readonly startTimeMs: number;
    readonly terminal?: {
        readonly error: unknown;
        readonly type: InstrumentationTurnFailedEvent["type"];
    } | {
        readonly type: InstrumentationTurnSettledEvent["type"];
    };
}
export interface AgentActionTraceState {
    readonly attemptIndex: number;
    readonly callId: string;
    readonly inputAttribute?: string;
    readonly kind: InstrumentationActionKind;
    readonly name: string;
    readonly parent: InstrumentationTraceContext;
    readonly rootSessionId: string;
    readonly sessionId: string;
    readonly spanId: string;
    readonly startTimeMs: number;
    readonly stepIndex: number;
    readonly turnId: string;
}
/** Provider-owned serializable storage for durable agent trace state. */
export interface AgentTraceStateStore {
    deleteAction(idempotencyKey: string): void | PromiseLike<void>;
    deleteActions(sessionId: string, turnId?: string): void | PromiseLike<void>;
    deleteSession(sessionId: string): void | PromiseLike<void>;
    deleteTurn(sessionId: string, turnId: string): void | PromiseLike<void>;
    findAction(sessionId: string, callId: string): AgentActionTraceState | undefined | PromiseLike<AgentActionTraceState | undefined>;
    getAction(idempotencyKey: string): AgentActionTraceState | undefined | PromiseLike<AgentActionTraceState | undefined>;
    getSession(sessionId: string): AgentSessionTraceState | undefined | PromiseLike<AgentSessionTraceState | undefined>;
    getTurn(sessionId: string, turnId: string): AgentTurnTraceState | undefined | PromiseLike<AgentTurnTraceState | undefined>;
    setAction(idempotencyKey: string, state: AgentActionTraceState): void | PromiseLike<void>;
    setSession(sessionId: string, state: AgentSessionTraceState): void | PromiseLike<void>;
    setTurn(sessionId: string, turnId: string, state: AgentTurnTraceState): void | PromiseLike<void>;
}
/** In-memory trace state used by tests and non-durable runtimes. */
export declare class InMemoryAgentTraceStateStore implements AgentTraceStateStore {
    #private;
    deleteAction(idempotencyKey: string): void;
    deleteActions(sessionId: string, turnId?: string): void;
    deleteSession(sessionId: string): void;
    deleteTurn(sessionId: string, turnId: string): void;
    findAction(sessionId: string, callId: string): AgentActionTraceState | undefined;
    getAction(idempotencyKey: string): AgentActionTraceState | undefined;
    getSession(sessionId: string): AgentSessionTraceState | undefined;
    getTurn(sessionId: string, turnId: string): AgentTurnTraceState | undefined;
    setAction(idempotencyKey: string, state: AgentActionTraceState): void;
    setSession(sessionId: string, state: AgentSessionTraceState): void;
    setTurn(sessionId: string, turnId: string, state: AgentTurnTraceState): void;
}
export declare function turnKey(sessionId: string, turnId: string): string;
