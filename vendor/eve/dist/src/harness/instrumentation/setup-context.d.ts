import type { ProviderSetupContext } from "#public/instrumentation/provider.js";
/**
 * Builds the context handed to an authored `setup` at server startup.
 *
 * Shared by both layouts so the two cannot drift: a divergent context type
 * would leave `defineInstrumentation`'s union without a contextual signature
 * for `setup`, silently making every authored `setup(context)` parameter an
 * implicit `any`.
 *
 * @internal — not part of the public API.
 */
export declare function createInstrumentationSetupContext(agentName: string): ProviderSetupContext;
