import type { InstrumentationAttemptScope, InstrumentationHooks, InstrumentationParentLineage, InstrumentationTraceContext } from "#harness/instrumentation/lifecycle.js";
import type { ResolvedInputBatch } from "#harness/input-requests.js";
import type { HandleEventFn } from "#harness/types.js";
export interface CreateInstrumentationHandleEventInput {
    readonly agentName?: string;
    readonly channelKind?: string;
    readonly getAttemptScope?: () => InstrumentationAttemptScope | undefined;
    readonly handleEvent?: HandleEventFn;
    readonly hooks?: InstrumentationHooks;
    readonly parentLineage?: InstrumentationParentLineage;
    readonly parentTraceContext?: InstrumentationTraceContext;
    readonly rootSessionId?: string;
    readonly sessionId: string;
    readonly turnId?: string;
}
/** Publishes eve-native lifecycle transitions after durable event acceptance. */
export declare function createInstrumentationHandleEvent(input: CreateInstrumentationHandleEventInput): HandleEventFn | undefined;
/** Publishes accepted input resolutions against their original request scope. */
export declare function publishInputResolutions(input: {
    readonly batch: ResolvedInputBatch;
    readonly hooks: InstrumentationHooks;
    readonly sessionId: string;
}): Promise<void>;
