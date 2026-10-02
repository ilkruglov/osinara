import { type ApplyModelSettingsOutcome } from "#setup/flows/model-source-change.js";
import type { AgentReasoningDefinition } from "#shared/agent-definition.js";
import type { AgentModelSettingsPatch } from "#source-change/apply-agent-model-settings.js";
export interface SetCommandLogger {
    error(message: string): void;
    log(message: string): void;
}
export interface SetCommandOptions {
    model?: string;
    reasoning?: AgentReasoningDefinition;
}
export interface SetCommandDependencies {
    changeAgentModelSettings: (input: {
        appRoot: string;
        patch: AgentModelSettingsPatch;
    }) => Promise<ApplyModelSettingsOutcome>;
}
export declare function runSetCommand(logger: SetCommandLogger, appRoot: string, options: SetCommandOptions, dependencies?: SetCommandDependencies): Promise<void>;
