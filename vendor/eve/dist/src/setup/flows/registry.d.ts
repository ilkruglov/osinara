import type { Prompter } from "#setup/prompter.js";
import { runDeployFlow } from "#setup/flows/deploy.js";
import { detectDeployment } from "#setup/project-resolution.js";
import type { RegistrySetupFact } from "#setup/registry-setup-protocol.js";
export interface RegistryFlowDeps {
    browseRegistryCatalog: (typeof import("#cli/commands/registry.js"))["browseRegistryCatalog"];
    detectDeployment: typeof detectDeployment;
    getRegistryItemManifest: (typeof import("#cli/commands/registry.js"))["getRegistryItemManifest"];
    installRegistryItem: (typeof import("#cli/commands/registry.js"))["installRegistryItem"];
    runDeployFlow: typeof runDeployFlow;
}
export type RegistryFlowResult = {
    kind: "done";
    addedItems: readonly string[];
    items: readonly import("./registry-session.js").RegistrySessionItemResult[];
    facts: readonly RegistrySetupFact[];
    output?: readonly string[];
    deployed?: "production";
} | {
    kind: "cancelled";
};
export declare class RegistryFlowFailedError extends Error {
    readonly completed: Extract<RegistryFlowResult, {
        kind: "done";
    }>;
    constructor(error: unknown, completed: Extract<RegistryFlowResult, {
        kind: "done";
    }>);
}
/** Runs the categorized interactive registry catalog used by the dev TUI's `/add`. */
export declare function runRegistryFlow(input: {
    appRoot: string;
    prompter: Prompter;
    signal?: AbortSignal;
    deps?: Partial<RegistryFlowDeps>;
}): Promise<RegistryFlowResult>;
