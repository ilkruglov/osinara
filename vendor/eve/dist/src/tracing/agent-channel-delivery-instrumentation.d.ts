import { type Tracer } from "#compiled/@opentelemetry/api/index.js";
import type { InstrumentationProviderDefinition, InstrumentationSessionStartedEvent } from "#harness/instrumentation/lifecycle.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import type { AgentSessionTraceState, AgentTraceStateStore } from "#tracing/agent-trace-state.js";
/** Builds durable channel delivery spans around the turn that consumes each request. */
export declare function createAgentChannelDeliveryInstrumentation(input: {
    readonly ensureSessionContext: (event: InstrumentationSessionStartedEvent) => Promise<AgentSessionTraceState>;
    readonly frameworkVersion: string;
    readonly idGenerator: AgentSpanIdGenerator;
    readonly recordInputs: boolean;
    readonly stateStore: AgentTraceStateStore;
    readonly tracer: Tracer;
}): Pick<NonNullable<InstrumentationProviderDefinition["events"]>, "channel.delivery.cancelled" | "channel.delivery.completed" | "channel.delivery.failed" | "channel.delivery.started">;
