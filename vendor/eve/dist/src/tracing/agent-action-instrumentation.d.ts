import { type Context, type SpanContext, type Tracer } from "#compiled/@opentelemetry/api/index.js";
import type { InstrumentationActionStartedEvent, InstrumentationAttemptScope, InstrumentationProviderDefinition } from "#harness/instrumentation/lifecycle.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import type { AgentTraceStateStore } from "#tracing/agent-trace-state.js";
export interface AgentActionInstrumentation {
    readonly events: Pick<NonNullable<InstrumentationProviderDefinition["events"]>, "action.completed" | "action.failed" | "action.started">;
    deleteForSession(sessionId: string): void | PromiseLike<void>;
    deleteForTurn(sessionId: string, turnId: string): void | PromiseLike<void>;
    failForAttempt(scope: InstrumentationAttemptScope, error: unknown): Promise<void>;
    contextFor(sessionId: string, turnId: string, callId: string): Promise<AgentActionContext | undefined>;
}
export interface AgentActionContext {
    readonly context: Context;
    readonly spanContext: SpanContext;
}
/** Builds durable `agent.action` spans around eve's runtime dispatch boundary. */
export declare function createAgentActionInstrumentation(input: {
    readonly frameworkVersion: string;
    readonly idGenerator: AgentSpanIdGenerator;
    readonly recordInputs: boolean;
    readonly recordOutputs: boolean;
    readonly resolveTraceContext: (event: InstrumentationActionStartedEvent) => SpanContext | undefined | PromiseLike<SpanContext | undefined>;
    readonly stateStore: AgentTraceStateStore;
    readonly tracer: Tracer;
}): AgentActionInstrumentation;
