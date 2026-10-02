import type { Span } from "#compiled/@opentelemetry/api/index.js";
import type { InstrumentationUsage } from "#harness/instrumentation/lifecycle.js";
/** Applies eve's structural token usage attributes to an agent span. */
export declare function setAgentUsage(span: Span, usage: InstrumentationUsage): void;
