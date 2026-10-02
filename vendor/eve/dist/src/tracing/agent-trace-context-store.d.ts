import type { SpanContext } from "#compiled/@opentelemetry/api/index.js";
import type { AgentActionTraceState, AgentSessionTraceState, AgentTraceStateStore, AgentTurnTraceState } from "#tracing/agent-trace-state.js";
/** Keeps only framework trace state from an interrupted step's context changes. */
export declare function preserveSerializedAgentTraceState(original: Record<string, unknown>, interrupted: Record<string, unknown>): Record<string, unknown>;
/**
 * Reads a named session's trace window straight out of a serialized context,
 * which {@link ContextAgentTraceStateStore} cannot do — its reads are scoped
 * to the ambient session.
 */
export declare function readSessionTraceContext(serializedContext: Readonly<Record<string, unknown>>, sessionId: string): SpanContext | undefined;
/** Reads the durable action span that should parent a dispatched child agent. */
export declare function readActionTraceContext(serializedContext: Readonly<Record<string, unknown>>, sessionId: string, turnId: string, callId: string): SpanContext | undefined;
/** Durable trace state backed by eve's serialized Workflow context. */
export declare class ContextAgentTraceStateStore implements AgentTraceStateStore {
    deleteAction(idempotencyKey: string): void;
    deleteActions(sessionId: string, turnId?: string): void;
    deleteSession(sessionId: string): void;
    deleteTurn(sessionId: string, turnId: string): void;
    findAction(sessionId: string, callId: string): AgentActionTraceState | undefined;
    getAction(idempotencyKey: string): AgentActionTraceState | undefined;
    getSession(sessionId: string): AgentSessionTraceState | undefined;
    getTurn(sessionId: string, turnId: string): AgentTurnTraceState | undefined;
    setAction(idempotencyKey: string, value: AgentActionTraceState): void;
    setSession(sessionId: string, value: AgentSessionTraceState): void;
    setTurn(sessionId: string, turnId: string, value: AgentTurnTraceState): void;
}
