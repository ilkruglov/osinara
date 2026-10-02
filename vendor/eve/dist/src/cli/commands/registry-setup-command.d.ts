import type { Prompter } from "#setup/prompter.js";
import { type RegistrySetupCompletion, type RegistrySetupBlocker } from "#setup/registry-setup-protocol.js";
export interface RegistrySetupCommand {
    package: string;
    bin: string;
    args: string[];
}
export type RegistrySetupCommandResult = ({
    kind: "completed";
} & RegistrySetupCompletion) | {
    kind: "blocked";
    blocker: RegistrySetupBlocker;
} | {
    kind: "cancelled";
};
export interface RegistrySetupCommandOptions {
    prompter: Prompter;
    signal?: AbortSignal;
}
/** Executes a trusted setup binary while the parent prompter owns all terminal interaction. */
export declare function runRegistrySetupCommand(appRoot: string, setup: RegistrySetupCommand, item: string, options?: RegistrySetupCommandOptions): Promise<RegistrySetupCommandResult>;
