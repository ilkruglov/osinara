import { type InstrumentationProviderDefinition } from "#harness/instrumentation/lifecycle.js";
import { type InstrumentationRuntime } from "#harness/instrumentation/runtime.js";
import type { CollectedOtel, RuntimeContextResolver } from "#tracing/otel-declaration.js";
/**
 * Installs the process instrumentation runtime around a collected pipeline.
 *
 * Both layouts land here. `eve dev`'s zero-config default and an authored
 * `agent/instrumentation/` directory differ only in where the declared values
 * came from, so sharing the install keeps them on one runtime path.
 *
 * A directory that declared no OpenTelemetry still gets a bus: its providers
 * see every event, they just have no spans to hang them on.
 */
export declare function installInstrumentationRuntime(input: {
    readonly collected: CollectedOtel;
    readonly frameworkVersion: string;
    readonly providers: readonly InstrumentationProviderDefinition[];
    readonly runtimeContextResolvers?: readonly RuntimeContextResolver[];
    readonly serviceName: string;
}): InstrumentationRuntime;
