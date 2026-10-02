import type { Prompter } from "./prompter.js";
import { type RegistrySetupChildMessage, type RegistrySetupCompletion, type RegistrySetupParentMessage } from "./registry-setup-protocol.js";
export interface SetupProcess {
    connected?: boolean;
    send?: (message: RegistrySetupChildMessage) => boolean;
    disconnect?: () => void;
    on(event: "message", listener: (message: RegistrySetupParentMessage) => void): unknown;
    off(event: "message", listener: (message: RegistrySetupParentMessage) => void): unknown;
}
export interface RegistrySetupClient {
    prompter: Prompter;
    signal: AbortSignal;
    complete(completion?: RegistrySetupCompletion): void;
    cancel(): void;
    fail(error: unknown): void;
}
/** Creates a prompter whose questions and output are rendered by the parent eve process. */
export declare function createRegistrySetupClient(input?: {
    process?: SetupProcess;
    signal?: AbortSignal;
}): RegistrySetupClient | undefined;
