import type { RuntimeTraceContext } from "#protocol/message.js";
import type { InstrumentationParentLineage, InstrumentationTraceContext } from "#harness/instrumentation/lifecycle.js";
import type { HarnessInstrumentation } from "#harness/instrumentation/runtime.js";
/** Prepares native session/turn tracing before their durable stream events. */
export declare function prepareTurnTraceContext(input: {
    readonly agentName?: string;
    readonly instrumentation?: HarnessInstrumentation;
    readonly parentLineage?: InstrumentationParentLineage;
    readonly parentTraceContext?: InstrumentationTraceContext;
    readonly rootSessionId: string;
    readonly sequence: number;
    readonly sessionId: string;
    readonly sessionStarted: boolean;
    readonly traceContext?: RuntimeTraceContext;
    readonly turnId: string;
}): Promise<RuntimeTraceContext | undefined>;
