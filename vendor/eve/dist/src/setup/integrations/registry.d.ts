import type { SetupIntegration } from "./types.js";
/** Built-in registry setup integrations in canonical picker order. */
export declare const SETUP_INTEGRATIONS: readonly SetupIntegration[];
/** Resolves one built-in setup integration by its registry setup name. */
export declare function setupIntegration(kind: string): SetupIntegration;
export { createSetupContexts, createSetupPresenter } from "./shared/ui.js";
