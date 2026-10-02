import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";
/**
 * The local spool, as a span processor.
 *
 * Session liveness and retention live in here rather than in the runtime that
 * installs it, so nothing an author puts in the same `spanProcessors` list can
 * see them — and eve's accept filter never reaches an author's exporters.
 */
export interface LocalTracesProcessor extends SpanProcessor {
    /**
     * Settles pending writes and drops one root session's liveness, then bounds
     * the store. A subagent child owns no traces, so releasing one is a no-op
     * and leaves the shared trace pinned until its root finishes.
     */
    releaseSession(sessionId: string): Promise<boolean>;
}
/**
 * Reports whether a processor tracks which session owns which trace, so eve can
 * tell it when that session is done.
 *
 * Anything standing between eve and the spool has to answer for the spool, so
 * this is the check a wrapper uses to decide whether it must forward the call.
 *
 * @internal
 */
export declare function hasSessionRelease(processor: SpanProcessor): processor is LocalTracesProcessor;
/**
 * Writes the OTLP/JSON spool under `.eve/traces/v1`.
 *
 * `EVE_TRACES=off` removes the writer but keeps the processor: eve still has
 * to observe spans to track which session owns which trace.
 *
 * Internal because of `releaseSession`, which eve's runtime drives off session
 * lifecycle. The authored surface is `localTraces()`, which wraps this in an
 * `OtelIntegration`.
 */
export declare function createLocalTracesProcessor(input?: {
    readonly appRoot?: string;
}): LocalTracesProcessor;
/**
 * The local spool's content policy: its options, intersected with
 * `EVE_TRACES_CONTENT`.
 *
 * The variable applies to this destination only. `on` opts the zero-config
 * spool into content, while `off` overrides authored local options without
 * changing what a hosted backend beside it receives.
 *
 * @internal
 */
export declare function resolveLocalTracesContent(options?: {
    readonly recordInputs?: boolean;
    readonly recordOutputs?: boolean;
}): {
    readonly recordInputs: boolean;
    readonly recordOutputs: boolean;
};
