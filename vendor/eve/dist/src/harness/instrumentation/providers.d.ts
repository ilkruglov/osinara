import { type InstrumentationRuntime } from "#harness/instrumentation/runtime.js";
import { type InstrumentationProvider } from "#public/instrumentation/provider.js";
/** One provider and the `instrumentation/<slot>.ts` file it came from. */
export interface RegisteredInstrumentationProvider {
    readonly provider: InstrumentationProvider;
    readonly slot: string;
}
/** Fills reserved slots before authored files may reconfigure or disable them. */
export declare function seedInstrumentationProviders(): void;
/**
 * Registers one authored provider and awaits its `setup`.
 *
 * Called once per `instrumentation/<slot>.ts` by the generated Nitro plugin at
 * server startup, before any event is published. A default export that is not
 * a `defineInstrumentation` result throws rather than being skipped: a slot
 * that registers nothing is telemetry that silently does nothing, which is the
 * failure this surface exists to prevent.
 *
 * @internal — not part of the public API.
 */
export declare function registerInstrumentationProvider(input: {
    readonly agentName: string;
    readonly slot: string;
    readonly value: unknown;
}): Promise<void>;
/** Registered providers in slot order. @internal */
export declare function getInstrumentationProviders(): readonly RegisteredInstrumentationProvider[];
/**
 * Installs the process instrumentation runtime from the registered providers.
 *
 * Called once by the generated Nitro plugin after every slot has registered,
 * which is also why it cannot happen inside `setup`: the OpenTelemetry pipeline
 * is the union of every destination declared in the directory, so no single
 * file knows enough to build it. A `setup` that reaches for a tracer therefore
 * gets the no-op one; declare destinations as values and let this assemble
 * them.
 *
 * A directory that declared no OpenTelemetry at all still gets a bus. Its
 * providers see every event; they just have no spans to hang them on.
 *
 * @internal — not part of the public API.
 */
export declare function finalizeInstrumentationProviders(input: {
    readonly serviceName: string;
}): InstrumentationRuntime;
/**
 * Releases every registered provider and OTel processor from Nitro's close
 * hook, the last point a buffered exporter can still reach the network.
 */
export declare function shutdownInstrumentationProviders(): Promise<void>;
