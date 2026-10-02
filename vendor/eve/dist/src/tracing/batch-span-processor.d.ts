import type { SpanExporter, SpanProcessor } from "#compiled/@vercel/otel/index.js";
/** @internal — exposed for tests; authors get the defaults. */
export interface BatchSpanProcessorOptions {
    readonly exportTimeoutMillis?: number;
    readonly maxExportBatchSize?: number;
    readonly maxQueueSize?: number;
    readonly scheduledDelayMillis?: number;
}
/**
 * Buffers ended spans and hands them to one exporter in batches.
 *
 * eve owns this rather than taking `@opentelemetry/sdk-trace-base` as a runtime
 * dependency: an exporter needs exactly one thing done for it, and the
 * dependency would arrive with the whole SDK behind it.
 *
 * A full queue drops the newest span rather than growing without bound. An
 * exporter that has stopped draining is already losing telemetry; taking the
 * agent's memory with it would turn that into an outage.
 */
export declare function batchSpanProcessor(exporter: SpanExporter, options?: BatchSpanProcessorOptions): SpanProcessor;
