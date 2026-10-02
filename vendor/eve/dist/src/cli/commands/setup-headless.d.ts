import type { RegistrySetupBlocker, RegistrySetupCompletion } from "#setup/registry-setup-protocol.js";
export interface HeadlessSetupCommand {
    command: string;
    args: readonly string[];
}
export type HeadlessSetupEvent = {
    version: 1;
    type: "progress";
    level?: "warning";
    message: string;
} | {
    version: 1;
    type: "external_action";
    id: string;
    blocking: true;
    message: string;
    url: string;
    userCode?: string;
} | {
    version: 1;
    type: "external_action_resolved";
    id: string;
} | {
    version: 1;
    type: "completed";
    item: string;
    completedItems: readonly string[];
    deploymentRequired?: true;
    next?: HeadlessSetupCommand;
} | ({
    version: 1;
    type: "blocked";
    item: string;
    installed: boolean;
    completedItems: readonly string[];
    next: HeadlessSetupCommand;
} & RegistrySetupBlocker) | {
    version: 1;
    type: "failed";
    item: string;
    completedItems: readonly string[];
    message: string;
    next?: HeadlessSetupCommand;
} | {
    version: 1;
    type: "cancelled";
    item: string;
    completedItems: readonly string[];
    next?: HeadlessSetupCommand;
};
export declare function headlessSetupContinuation(input: {
    item: string;
    installed: boolean;
    question?: Extract<RegistrySetupBlocker, {
        status: "input_required";
    }>["question"];
}): HeadlessSetupCommand;
export type HeadlessIntegrationSetupEvent = {
    version: 1;
    type: "external_action";
    id: string;
    blocking: true;
    message: string;
    url: string;
    userCode?: string;
} | {
    version: 1;
    type: "external_action_resolved";
    id: string;
} | {
    version: 1;
    type: "completed";
    item: string;
} | {
    version: 1;
    type: "cancelled";
    item: string;
} | ({
    version: 1;
    type: "blocked";
} & RegistrySetupBlocker);
export declare function reportHeadlessSetupCompletion(input: {
    logger: {
        log(message: string): void;
    };
    item: string;
    completion: RegistrySetupCompletion | false;
    nonInteractive: boolean | undefined;
}): RegistrySetupCompletion | undefined;
export declare function serializeHeadlessSetupEvent(event: HeadlessSetupEvent | HeadlessIntegrationSetupEvent): string;
