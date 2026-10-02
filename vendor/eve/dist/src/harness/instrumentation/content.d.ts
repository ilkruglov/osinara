import type { InstrumentationEvent } from "#harness/instrumentation/lifecycle.js";
/** Returns an immutable event projection with conversation content removed. */
export declare function withoutInstrumentationContent(event: InstrumentationEvent): InstrumentationEvent;
/** Provider metadata fields that describe cost/identity rather than content. */
export declare function structuralProviderMetadata(metadata: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
