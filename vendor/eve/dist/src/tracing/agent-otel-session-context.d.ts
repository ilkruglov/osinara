import type { Tracer } from "#compiled/@opentelemetry/api/index.js";
import { type InstrumentationSessionStartedEvent, type InstrumentationTraceContext, type InstrumentationTurnStartedEvent } from "#harness/instrumentation/lifecycle.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import { type AgentSessionTraceState, type AgentTraceStateStore } from "#tracing/agent-trace-state.js";
interface AgentOtelSessionContextInput {
    readonly frameworkVersion: string;
    readonly idGenerator: AgentSpanIdGenerator;
    readonly stateStore: AgentTraceStateStore;
    readonly tracer: Tracer;
}
interface AgentOtelSessionContext {
    readonly ensureSessionContext: (event: InstrumentationSessionStartedEvent) => Promise<AgentSessionTraceState>;
    readonly prepareSessionTrace: (event: InstrumentationSessionStartedEvent) => Promise<InstrumentationTraceContext>;
    readonly prepareTurnTrace: (event: InstrumentationTurnStartedEvent) => Promise<InstrumentationTraceContext>;
}
export declare function createAgentOtelSessionContext(input: AgentOtelSessionContextInput): AgentOtelSessionContext;
export {};
