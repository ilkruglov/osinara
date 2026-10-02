import { type Tracer } from "#compiled/@opentelemetry/api/index.js";
import type { InstrumentationProviderDefinition } from "#harness/instrumentation/lifecycle.js";
import type { AgentActionContext } from "#tracing/agent-action-instrumentation.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
/** Builds durable approval wait spans under their originating runtime action. */
export declare function createAgentApprovalInstrumentation(input: {
    readonly actionContextFor: (sessionId: string, turnId: string, callId: string) => Promise<AgentActionContext | undefined>;
    readonly frameworkVersion: string;
    readonly idGenerator: AgentSpanIdGenerator;
    readonly recordInputs: boolean;
    readonly recordOutputs: boolean;
    readonly tracer: Tracer;
}): Pick<NonNullable<InstrumentationProviderDefinition["events"]>, "input.requested" | "input.resolved">;
