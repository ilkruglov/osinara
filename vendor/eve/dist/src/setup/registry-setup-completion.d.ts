import type { RegistrySetupCompletion } from "./registry-setup-protocol.js";
/** Combines setup completions while preserving their facts and deployment requirement. */
export declare function mergeRegistrySetupCompletions(...completions: readonly RegistrySetupCompletion[]): RegistrySetupCompletion;
