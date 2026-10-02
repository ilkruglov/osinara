import type { InstrumentationDefinition } from "#public/instrumentation/index.js";
/**
 * Registers the authored instrumentation config and awaits its `setup`
 * callback.
 *
 * Called once by the generated instrumentation Nitro plugin at server
 * startup. Subsequent calls overwrite the previous value.
 *
 * The store write lands before `setup` runs so a synchronous caller sees the
 * config without waiting on the returned promise.
 *
 * @internal — not part of the public API.
 */
export declare function registerInstrumentationConfig(config: InstrumentationDefinition, input: {
    readonly agentName: string;
}): Promise<void>;
/**
 * Returns the registered instrumentation config, or `undefined` when no
 * `defineInstrumentation` export was provided.
 *
 * @internal — not part of the public API.
 */
export declare function getInstrumentationConfig(): InstrumentationDefinition | undefined;
