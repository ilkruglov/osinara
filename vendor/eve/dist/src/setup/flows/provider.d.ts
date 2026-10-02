import { appendEnv } from "../append-env.js";
import type { Prompter, SelectOption } from "../prompter.js";
import { validateGatewayApiKey, type GatewayKeyValidation } from "../validate-gateway-key.js";
import { getVercelAuthStatus } from "../vercel-project.js";
import type { ProviderSelection } from "#setup/provider-settings.js";
import { runLinkFlow } from "./link.js";
export type ProviderConnection = ProviderSelection | "external";
export declare const PROVIDER_QUESTION = "Which model provider do you want to use?";
export declare const EXTERNAL_PROVIDER_INSTRUCTIONS_TITLE = "Using another model provider";
export declare const EXTERNAL_PROVIDER_INSTRUCTIONS: readonly string[];
/** Injected for tests; defaults to the real link flow, env write, and key check. */
export interface ProviderFlowDeps {
    getVercelAuthStatus: typeof getVercelAuthStatus;
    runLinkFlow: typeof runLinkFlow;
    appendEnv: typeof appendEnv;
    validateGatewayApiKey: typeof validateGatewayApiKey;
}
export type ProviderFlowResult = {
    kind: ProviderSelection | "cancelled" | "external-provider";
};
type AcceptedGatewayKeyValidation = Exclude<GatewayKeyValidation, {
    kind: "invalid";
}>;
/** A provider choice, including the accepted evidence for an inline key. */
export type ProviderPickerChoice = {
    kind: "ai-gateway-project";
} | {
    kind: "chatgpt";
} | {
    kind: "external";
} | {
    kind: "ai-gateway-key";
    key: string;
    validation: AcceptedGatewayKeyValidation;
};
/** Private Dev TUI request for the provider's one-screen chooser. */
export interface ProviderPickerRequest {
    message: string;
    options: readonly SelectOption<ProviderConnection>[];
    initialValue: ProviderConnection;
    validateInlineKey(key: string, signal: AbortSignal): Promise<GatewayKeyValidation>;
}
/** Renderer-owned provider chooser; only the Dev TUI invokes this flow. */
export type ProviderPicker = (request: ProviderPickerRequest) => Promise<ProviderPickerChoice | undefined>;
/**
 * THE PROVIDER FLOW behind the dev TUI `/model` menu's provider row
 * (`eve link` keeps {@link runLinkFlow}'s shape). One question chooses a
 * project-backed AI Gateway connection, an `AI_GATEWAY_API_KEY`, ChatGPT, or a
 * direct provider. Selecting an available but inactive project only changes
 * the selection; selecting the active project opens the link flow so it can
 * be replaced. A project-less agent can create its first project there rather
 * than dead-end on an empty list.
 */
export declare function runProviderFlow(input: {
    appRoot: string;
    prompter: Prompter;
    signal?: AbortSignal;
    picker?: ProviderPicker;
    /** Provider availability resolved before the picker opened. */
    availableProviders: readonly ProviderSelection[];
    /** The current provider selection. */
    selectedProvider: ProviderSelection;
    deps?: Partial<ProviderFlowDeps>;
}): Promise<ProviderFlowResult>;
export {};
