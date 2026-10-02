import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";
import { type ResolvedContentOptions } from "#tracing/content-attributes.js";
/**
 * Puts one destination's content policy in front of it.
 *
 * Content is written onto a span if any destination wants it, so the span
 * reaching a destination that declined still carries it. This cannot strip the
 * attribute in place: that span object is shared with every other processor in
 * the pipeline, and editing it would strip the attribute everywhere. So it
 * gives the destination a facade whose attributes omit what it declined.
 *
 * One facade follows the original from start through end. This preserves the
 * object identity stateful processors key on without ever exposing the original
 * span or its attribute map. Methods stay bound to the original, so private SDK
 * state remains reachable without eve knowing that SDK's concrete span shape.
 *
 * @internal
 */
export declare function contentFilteringProcessor(downstream: SpanProcessor, content: ResolvedContentOptions): SpanProcessor;
