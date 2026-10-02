import type { VercelProjectReference } from "#setup/project-resolution.js";
import { deriveSlackConnectorSlug } from "#setup/scaffold/index.js";
import { writeTextFile } from "#setup/scaffold/files.js";
import { type SetupApplyContext, type SetupPrepareContext } from "../types.js";
import { configureDiscordInteractionsEndpoint, registerDiscordCommand, resolveDiscordApplication } from "./api.js";
import { provisionDiscordConnector } from "./connect.js";
export interface DiscordSetupDeps {
    configureEndpoint: typeof configureDiscordInteractionsEndpoint;
    deriveConnectorSlug: typeof deriveSlackConnectorSlug;
    provisionConnector: typeof provisionDiscordConnector;
    registerCommand: typeof registerDiscordCommand;
    resolveApplication: typeof resolveDiscordApplication;
    writeTextFile: typeof writeTextFile;
}
export interface DiscordSetupPlan {
    botToken: string;
    commandName: string;
    commandDescription: string;
    project: VercelProjectReference;
    slug: string;
}
export declare function prepareDiscordSetup(context: SetupPrepareContext, deps?: DiscordSetupDeps): Promise<DiscordSetupPlan>;
export declare function applyDiscordSetup(plan: DiscordSetupPlan, context: SetupApplyContext, deps?: DiscordSetupDeps): Promise<{
    deploymentRequired: true;
    facts: {
        label: string;
        value: string;
        kind: "url";
    }[];
}>;
export declare const DISCORD_SETUP: import("../types.js").SetupIntegration;
