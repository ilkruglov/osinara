import { type Tracer } from "#compiled/@opentelemetry/api/index.js";
import type { AgentTraceStateStore } from "#tracing/agent-trace-state.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import type { InstrumentationContextRunner, InstrumentationProviderDefinition, InstrumentationSessionStartedEvent, InstrumentationTraceContext, InstrumentationTurnStartedEvent } from "#harness/instrumentation/lifecycle.js";
export interface AgentOtelInstrumentationInput {
    /**
     * Whether to write model prompts and tool call inputs onto spans at all.
     * This is the union across destinations, not one destination's policy: a
     * destination that declined drops these on its way out instead.
     */
    readonly recordInputs?: boolean;
    /** The same, for model responses and tool call outputs. */
    readonly recordOutputs?: boolean;
    readonly frameworkVersion: string;
    readonly idGenerator: AgentSpanIdGenerator;
    readonly stateStore: AgentTraceStateStore;
    readonly tracer: Tracer;
}
/** OTel event definition and its trusted framework context runner. */
export interface AgentOtelInstrumentation {
    readonly hook: InstrumentationProviderDefinition;
    readonly prepareSessionTrace: (event: InstrumentationSessionStartedEvent) => Promise<InstrumentationTraceContext>;
    readonly prepareTurnTrace: (event: InstrumentationTurnStartedEvent) => Promise<InstrumentationTraceContext>;
    readonly runInContext: InstrumentationContextRunner;
}
/** Creates OTel instrumentation for eve's structural `agent.*` convention. */
export declare function createAgentOtelInstrumentation(input: AgentOtelInstrumentationInput): AgentOtelInstrumentation;
