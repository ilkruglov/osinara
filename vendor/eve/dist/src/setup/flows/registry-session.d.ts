import type { Prompter } from "#setup/prompter.js";
import { detectDeployment } from "#setup/project-resolution.js";
import type { RegistrySetupCompletion, RegistrySetupFact } from "#setup/registry-setup-protocol.js";
import { runDeployFlow } from "./deploy.js";
export interface RegistrySessionDeps {
    detectDeployment: typeof detectDeployment;
    runDeployFlow: typeof runDeployFlow;
}
export interface RegistrySessionItemResult {
    address: string;
    title: string;
    facts: readonly RegistrySetupFact[];
    output: readonly string[];
}
export interface RegistrySessionResult {
    kind: "done";
    addedItems: readonly string[];
    items: readonly RegistrySessionItemResult[];
    facts: readonly RegistrySetupFact[];
    output: readonly string[];
    deployed?: "production";
}
export interface RegistrySession {
    add(item: string, title: string, output: readonly string[], setup?: RegistrySetupCompletion): void;
    result(deployed?: "production"): RegistrySessionResult;
    continueAfterInstall(input: {
        appRoot: string;
        prompter: Prompter;
        signal?: AbortSignal;
    }): Promise<"add-more" | RegistrySessionResult>;
}
/** Owns the accumulated output and deployment decision for one `/add` session. */
export declare function createRegistrySession(deps: RegistrySessionDeps): RegistrySession;
