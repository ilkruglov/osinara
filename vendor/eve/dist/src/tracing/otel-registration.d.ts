import { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import type { OtelPipeline } from "#tracing/otel-declaration.js";
/**
 * Builds the process's one OpenTelemetry tracer provider from a merged
 * declaration, then proves it took the global slot.
 *
 * `registerOTel` reports a refused registration only through `diag`, which
 * goes nowhere unless `OTEL_LOG_LEVEL` is set, so a second caller would export
 * nothing and say nothing. eve primes its id generator and installs a private
 * propagator, then verifies both through the global APIs.
 */
export declare function registerOtelPipeline(input: {
    readonly pipeline: OtelPipeline;
    readonly serviceName: string;
}): RegisteredOtelPipeline;
/** Lifecycle retained from the tracer provider that owns every destination. */
export interface RegisteredOtelPipeline {
    readonly forceFlush: () => Promise<void>;
    readonly idGenerator: AgentSpanIdGenerator;
    readonly shutdown: () => Promise<void>;
}
