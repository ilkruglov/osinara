import { type Context, type SpanContext, type Tracer } from "#compiled/@opentelemetry/api/index.js";
import type { InstrumentationActionStartedEvent, InstrumentationToolCallStartedEvent, InstrumentationToolCallTerminalEvent } from "#harness/instrumentation/lifecycle.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import type { AgentActionContext } from "#tracing/agent-action-instrumentation.js";
export interface AgentToolInstrumentation {
    actionStarted(event: InstrumentationActionStartedEvent): Promise<void>;
    contextFor(attemptId: string, idempotencyKey: string): Context | undefined;
    drain(attemptId: string, failure?: {
        readonly error: unknown;
    }): void;
    readonly events: {
        readonly "tool.call.completed": (event: InstrumentationToolCallTerminalEvent) => Promise<void>;
        readonly "tool.call.failed": (event: InstrumentationToolCallTerminalEvent) => Promise<void>;
        readonly "tool.call.started": (event: InstrumentationToolCallStartedEvent) => Promise<void>;
    };
}
/** Keeps SDK tool spans parented to actions even when SDK telemetry wins the event race. */
export declare function createAgentToolInstrumentation(input: {
    readonly actionContextFor: (sessionId: string, turnId: string, callId: string) => Promise<AgentActionContext | undefined>;
    readonly idGenerator: AgentSpanIdGenerator;
    readonly recordInputs: boolean;
    readonly recordOutputs: boolean;
    readonly resolveFallback: (event: InstrumentationToolCallStartedEvent) => {
        readonly context: Context;
        readonly spanContext: SpanContext;
    } | undefined;
    readonly tracer: Tracer;
}): AgentToolInstrumentation;
