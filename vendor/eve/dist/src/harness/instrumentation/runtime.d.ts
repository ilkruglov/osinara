import type { InstrumentationContextRunner, InstrumentationHooks, InstrumentationSessionStartedEvent, InstrumentationTraceContext, InstrumentationTurnStartedEvent } from "#harness/instrumentation/lifecycle.js";
import type { OtelHarnessSettings, RuntimeContextResolver } from "#tracing/otel-declaration.js";
/** Process-wide runtime consumed by every harness execution surface. */
export interface InstrumentationRuntime {
    readonly forceFlush: () => Promise<void>;
    readonly hooks: InstrumentationHooks;
    readonly prepareSessionTrace?: (event: InstrumentationSessionStartedEvent) => Promise<InstrumentationTraceContext>;
    readonly prepareTurnTrace?: (event: InstrumentationTurnStartedEvent) => Promise<InstrumentationTraceContext>;
    otelSettings: OtelHarnessSettings | undefined;
    /** Provider `runtimeContext` resolvers, collected at install time. */
    readonly runtimeContextResolvers?: readonly RuntimeContextResolver[];
    readonly runInContext: InstrumentationContextRunner;
    readonly shutdown: () => Promise<void>;
}
/** Instrumentation capabilities consumed inside one harness execution. */
export type HarnessInstrumentation = Pick<InstrumentationRuntime, "hooks" | "prepareSessionTrace" | "prepareTurnTrace" | "runInContext">;
/** Registers the process instrumentation runtime before agent execution begins. */
export declare function registerInstrumentationRuntime(runtime: InstrumentationRuntime): InstrumentationRuntime;
/** Returns the process instrumentation runtime, when one was installed. */
export declare function getInstrumentationRuntime(): InstrumentationRuntime | undefined;
