import type { PropagatorOrName, SamplerOrName, SpanExporter, SpanProcessor, SpanProcessorOrName } from "#compiled/@vercel/otel/index.js";
import { type InstrumentationProvider } from "#public/instrumentation/provider.js";
import type { InstrumentationRuntimeContextInput } from "#public/instrumentation/index.js";
import type { JsonObject } from "#shared/json.js";
import type { ResolvedContentOptions } from "#tracing/content-attributes.js";
/**
 * The process-wide OpenTelemetry settings, declared by `otel()`.
 *
 * Everything here is a singleton, which is why it is one file: a process has
 * one tracer provider, so it has one resource, one sampler, and one propagator
 * set. Destinations are the plural half and live in `otelIntegration()`.
 *
 * `contextManager` is deliberately absent: eve's span nesting depends on it.
 * `instrumentations` is accepted so providers can opt into Node auto-
 * instrumentations (e.g. `@opentelemetry/auto-instrumentations-node`); the
 * packages patch modules eve already imported, so their effects are limited
 * to code loaded after registration.
 */
export interface OtelOptions {
    /**
     * The function identifier attached to telemetry spans
     * (`ai.telemetry.functionId`). Defaults to the agent name.
     */
    readonly functionId?: string;
    /**
     * Whether to emit the inbound HTTP `SERVER` span that wraps each channel
     * request — the parent of the turn trace and of any `hook.resume` or
     * outgoing HTTP spans. Defaults to `false`.
     */
    readonly traceChannelRequests?: boolean;
    /**
     * Resource attributes merged into eve's own, which already carry the
     * service name.
     */
    readonly resource?: Readonly<Record<string, unknown>>;
    /**
     * Head sampling, and it is global: it decides whether a span is created at
     * all, so it thins eve's own sinks and the `traceparent` eve propagates
     * along with your exporters. To thin one backend only, drop spans in a
     * processor.
     */
    readonly sampler?: SamplerOrName;
    /** Composed into one propagator. All inject; the first to extract wins. Defaults to `auto`. */
    readonly propagators?: readonly PropagatorOrName[];
    /**
     * OpenTelemetry `Instrumentation` instances passed through to
     * `registerOTel`. Use them to patch Node.js built-ins (HTTP, DNS, fs, etc.)
     * for automatic spans around outbound work. Disabled by default because eve
     * already imports the model SDK before registration, so patching cannot
     * reach it — but code loaded after registration (tool modules, connection
     * clients) will be instrumented.
     */
    readonly instrumentations?: readonly unknown[];
}
/**
 * What one destination records of the conversation itself.
 *
 * Declining is per destination, not per process: content is written onto the
 * span if any destination wants it, and one that declined never exports it. So
 * an agent whose every destination declines still never materializes a prompt —
 * the union of nothing is nothing — but a local spool and a hosted backend no
 * longer have to agree.
 */
export interface ContentOptions {
    /** Record model prompts and tool call inputs. Defaults to `false`. */
    readonly recordInputs?: boolean;
    /** Record model responses and tool call outputs. Defaults to `false`. */
    readonly recordOutputs?: boolean;
}
/** Where one `otelIntegration()` sends spans, and what it records. */
export interface OtelIntegrationOptions extends ContentOptions {
    /** Merged into the pipeline in declaration order. */
    readonly spanProcessors?: readonly SpanProcessor[];
    /** Wrapped in eve's batching processor and appended after `spanProcessors`. */
    readonly traceExporter?: SpanExporter;
    /**
     * Contributes runtime context that the AI SDK merges into telemetry spans
     * for each model call. Child spans inherit the values, so a destination can
     * stamp channel or auth identity onto every span in the turn.
     *
     * Synchronous: the harness collects from every destination before the model
     * call, so a return that is not a plain object is dropped (warning-only).
     * Keys beginning with `eve.` are reserved and dropped. Return `undefined`
     * to contribute nothing.
     */
    readonly runtimeContext?: (input: InstrumentationRuntimeContextInput) => JsonObject | undefined;
}
declare const OTEL_DECLARATION: unique symbol;
declare const OTEL_INTEGRATION: unique symbol;
/**
 * The declared OpenTelemetry pipeline settings. eve collects this before
 * building the tracer provider, so it is a value rather than a side effect.
 */
export interface OtelDeclaration extends InstrumentationProvider {
    readonly [OTEL_DECLARATION]: true;
    readonly options: OtelOptions;
}
/** One declared destination. A process may have as many as it has files. */
export interface OtelIntegration extends InstrumentationProvider {
    readonly [OTEL_INTEGRATION]: true;
    /** Resolved from `ContentOptions`, so the union does not re-apply defaults. */
    readonly content: ResolvedContentOptions;
    readonly runtimeContext?: (input: InstrumentationRuntimeContextInput) => JsonObject | undefined;
    readonly spanProcessors: readonly SpanProcessorOrName[];
}
/**
 * Declares the process-wide OpenTelemetry settings.
 *
 * Export it from `agent/instrumentation/otel.ts`. Omitting the file is the
 * common case: eve registers the pipeline for whatever destinations are
 * declared beside it, and this only names what those destinations share.
 */
export declare function otel(options?: OtelOptions): OtelDeclaration;
/**
 * Declares one destination for this agent's traces.
 *
 * A `traceExporter` is wrapped in eve's batching processor, which is what makes
 * the one-line form of a hosted backend enough. Pass `spanProcessors` instead
 * when the destination needs its own batching, sampling, or filtering.
 *
 * Declining content wraps every processor here, an author's included: they are
 * this destination, and the point of declining is that nothing under it sees
 * what was said.
 */
export declare function otelIntegration(options?: OtelIntegrationOptions): OtelIntegration;
/** Vercel Agent Runs through the production request-context transport. @internal */
export declare function agentRunsIntegration(options?: ContentOptions): OtelIntegration;
export declare function resolveContentOptions(options: ContentOptions): ResolvedContentOptions;
export declare function isOtelDeclaration(value: unknown): value is OtelDeclaration;
export declare function isOtelIntegration(value: unknown): value is OtelIntegration;
/** The one pipeline a process can register. @internal */
export interface OtelPipeline {
    readonly instrumentations?: readonly unknown[];
    readonly propagators?: readonly PropagatorOrName[];
    readonly resource?: Readonly<Record<string, unknown>>;
    readonly sampler?: SamplerOrName;
    readonly spanProcessors: readonly SpanProcessorOrName[];
}
/** What the harness reads at turn time, as opposed to at registration. @internal */
export interface OtelHarnessSettings {
    readonly functionId?: string;
    readonly traceChannelRequests: boolean;
    /**
     * What to write onto a span at all, as opposed to what any one destination
     * exports. `agent/instrumentation.ts` sets this directly; a provider
     * directory arrives at it as the union of its destinations.
     */
    readonly recordInputs?: boolean;
    readonly recordOutputs?: boolean;
}
/** @internal */
export type RuntimeContextResolver = (input: InstrumentationRuntimeContextInput) => JsonObject | undefined;
/** @internal */
export interface CollectedOtel {
    /**
     * Whether anything declared OpenTelemetry. False means eve should leave the
     * global tracer provider slot alone rather than register an empty pipeline.
     */
    readonly declared: boolean;
    readonly pipeline: OtelPipeline;
    readonly runtimeContextResolvers: readonly RuntimeContextResolver[];
    readonly settings: OtelHarnessSettings;
}
/**
 * Folds the declared values into the one pipeline a process can register.
 *
 * Destinations concatenate in declaration order. The singletons cannot: two
 * `otel()` values is a boot error rather than a silent win for whichever eve
 * happened to visit first. With one declaration per file that collision needs
 * two files both exporting `otel()`, which is the only way to reach it.
 *
 * Content capture is the union of what the destinations asked for, because it
 * governs what is written rather than what is exported. Each destination's own
 * processors already drop what it declined.
 *
 * @internal
 */
export declare function collectOtelPipeline(values: readonly unknown[]): CollectedOtel;
export {};
