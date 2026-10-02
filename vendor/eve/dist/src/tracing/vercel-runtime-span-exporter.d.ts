import type { SpanExporter, SpanProcessor } from "#compiled/@vercel/otel/index.js";
/** The request-context transport behind @vercel/otel's automatic processor. */
export declare function vercelRuntimeSpanExporter(): SpanExporter;
/** Reports immediately so the span stays attached to its request context. */
export declare function vercelRuntimeSpanProcessor(): SpanProcessor;
