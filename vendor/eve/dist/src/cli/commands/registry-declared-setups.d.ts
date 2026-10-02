import { type Prompter } from "#setup/prompter.js";
import type { RegistrySetupCompletion } from "#setup/registry-setup-protocol.js";
import type { RegistryCommandLogger, RegistrySetupDependencies } from "./registry.js";
import type { RegistrySetupCommand } from "./registry-setup-command.js";
export interface DeclaredSetupOptions {
    yes?: boolean;
    nonInteractive?: boolean;
    answers?: Record<string, unknown>;
    silent?: boolean;
    prompter?: Prompter;
    signal?: AbortSignal;
}
/** Runs and combines the setup commands declared by one registry item. */
export declare function runDeclaredSetups(input: {
    logger: RegistryCommandLogger;
    appRoot: string;
    item: string;
    setups: readonly RegistrySetupCommand[] | undefined;
    options: DeclaredSetupOptions;
    dependencies: RegistrySetupDependencies;
    cancelledReminder: string;
    resumeCommand: string;
}): Promise<RegistrySetupCompletion | false>;
