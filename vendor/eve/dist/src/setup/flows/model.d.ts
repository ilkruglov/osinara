import { readProviderSelection, resolveAvailableProviders, writeProviderSelection, type ProviderSelection } from "#setup/provider-settings.js";
import type { AgentModelSettingsPatch } from "#source-change/apply-agent-model-settings.js";
import { type SelectModelDeps } from "../boxes/select-model.js";
import { type GatewayModelCapabilities, type ReasoningLevel } from "../boxes/model-capabilities.js";
import type { AgentReasoningDefinition, ModelRouting } from "#shared/agent-definition.js";
import { type GatewayServiceTierState } from "#shared/gateway-service-tier.js";
import type { Prompter, SelectOption } from "../prompter.js";
import { type ApplyModelSettingsOutcome } from "./model-source-change.js";
import { ensureChatGptAuth } from "./chatgpt-auth.js";
import { runProviderFlow } from "./provider.js";
/** The current model id, its routing, and whether `/model` can rewrite it. */
export interface CurrentAgentModel {
    id: string | null;
    routing: ModelRouting | null;
    reasoning: AgentReasoningDefinition | null;
    serviceTier: GatewayServiceTierState;
    /**
     * The authored `model` is a string the source editor can rewrite. False for a
     * source-backed SDK model call (`gateway(...)`, `anthropic(...)`), which is
     * not a string literal — independent of how the model routes.
     */
    editable: boolean;
    /** Whether the top-level agent config object can carry reasoning/tier edits. */
    settingsEditable: boolean;
}
export type { GatewayServiceTierState };
/**
 * Everything the composite Change-model screen edits, resolved before it
 * opens. The model section is a searchable catalog pick, or a fixed line when
 * the authored model is a source-backed SDK call `/model` cannot rewrite.
 */
export interface ModelSettingsRequest {
    model: {
        kind: "pick";
        options: readonly SelectOption<string>[];
        current: string | null;
    } | {
        kind: "fixed";
        current: string | null;
        reason: string;
    };
    /** Authored reasoning effort; null means the provider default. */
    reasoning: ReasoningLevel | null;
    /** Authored Gateway service tier. */
    serviceTier: GatewayServiceTierState;
    /** Whether the agent config object can carry reasoning/tier edits. */
    settingsEditable: boolean;
    /** True for a direct external provider, where Gateway tiers do not apply. */
    externalRouting: boolean;
    /** Capability lookup over the already-fetched catalog; called on every pick. */
    capabilitiesFor(modelId: string | null): GatewayModelCapabilities | undefined;
}
/**
 * The screen's draft on Done. Each field is present only when it differs from
 * the authored value; `"default"` and `"standard"` mean "remove the setting".
 */
export interface ModelSettingsResult {
    model?: string;
    reasoning?: "default" | ReasoningLevel;
    serviceTier?: "standard" | "priority";
}
/** Renderer-owned composite model screen; only the dev TUI implements this. */
export type ModelSettingsPicker = (request: ModelSettingsRequest) => Promise<ModelSettingsResult | undefined>;
/** Injected for tests; defaults to the real reads, fetches, and source edit. */
export interface ModelFlowDeps {
    /**
     * Reads the model the runtime currently serves and how it routes; both null
     * before the first compile.
     */
    readCurrentModel: (appRoot: string) => Promise<CurrentAgentModel>;
    /** Applies one completed `/model` draft to authored source. */
    applySettings: (input: {
        appRoot: string;
        patch: AgentModelSettingsPatch;
    }) => Promise<ApplyModelSettingsOutcome>;
    /** Catalog fetch behind the shared model picker. */
    selectModel?: SelectModelDeps;
    /** The composite Change-model screen; the dev TUI renderer implements it. */
    pickModelSettings?: ModelSettingsPicker;
    /** Resolves provider credentials available to this project. */
    resolveAvailableProviders: typeof resolveAvailableProviders;
    /** Reads the explicit provider selection, if one has been made. */
    readProviderSelection: typeof readProviderSelection;
    /** The provider sub-flow behind the menu's provider row. */
    runProviderFlow: typeof runProviderFlow;
    /** Ensures Codex owns a usable login before selecting ChatGPT. */
    ensureChatGptAuth: typeof ensureChatGptAuth;
    writeProviderSelection: typeof writeProviderSelection;
}
export type ModelFlowResult = {
    kind: "cancelled";
    /** True when Esc dropped drafted setting changes that Done would commit. */
    discardedDraft?: boolean;
} | {
    kind: "done";
    /** Whether authored source, auth, or Gateway selection committed. */
    accessChanged: boolean;
    /** The last apply line, when the model was changed this session. */
    modelMessage?: string;
    /** The provider selected in a completed provider sub-flow. */
    providerSelection?: ProviderSelection;
};
export declare const MODEL_MENU_MESSAGE = "";
/**
 * THE MODEL FLOW for the dev TUI's `/model`: a root menu whose Change model
 * row opens the composite model screen (catalog pick, reasoning-effort slider,
 * service-tier toggle) and whose provider row runs {@link runProviderFlow}.
 * Authored setting changes stay in memory until Done, then land through one
 * source transform and atomic rename. A completed provider change commits the
 * current draft and returns to the prompt; cancelled flows and
 * external-provider instructions return to the menu.
 */
export declare function runModelFlow(input: {
    appRoot: string;
    prompter: Prompter;
    /** Opens provider setup before the root menu when runtime evidence requires it. */
    initialStep?: "provider";
    signal?: AbortSignal;
    /** Gives Codex uncontested inherited stdio while it performs login. */
    withExclusiveTerminal?: <T>(task: () => Promise<T>) => Promise<T>;
    /** Live ChatGPT identity shown in this configuration flow only. */
    chatGptAccountLabel?: string;
    deps?: Partial<ModelFlowDeps>;
}): Promise<ModelFlowResult>;
/**
 * Refusal message when `/model` can't rewrite the model — it is a source-backed
 * SDK model call (`gateway(...)`, `anthropic(...)`), not a string literal — or
 * null when the model is an editable string. Editability is independent of
 * routing: a `gateway(...)` call is gateway-routed yet still uneditable here.
 */
export declare function modelChangeRefusalForUneditableModel(appRoot: string): Promise<string | null>;
