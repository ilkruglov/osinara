import { type Prompter } from "#setup/prompter.js";
import { type SetupProcess } from "#setup/registry-setup-client.js";
import { type IntegrationSetupRunnerDeps } from "#setup/integrations/runner.js";
import type { RegistryCommandLogger } from "./registry.js";
export interface IntegrationSetupOptions {
    yes?: boolean;
    nonInteractive?: boolean;
    answers?: Record<string, unknown>;
    signal?: AbortSignal;
}
export interface IntegrationSetupDependencies {
    createPrompter?: () => Prompter;
    runnerDeps?: IntegrationSetupRunnerDeps;
    setupProcess?: SetupProcess;
}
/** Runs built-in integration setup after its registry payload is installed. */
export declare function runIntegrationSetupCommand(logger: RegistryCommandLogger, appRoot: string, kind: string, options?: IntegrationSetupOptions, dependencies?: IntegrationSetupDependencies): Promise<void>;
