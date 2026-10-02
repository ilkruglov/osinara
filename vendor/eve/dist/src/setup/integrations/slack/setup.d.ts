import type { VercelProjectReference } from "#setup/project-resolution.js";
import { deriveSlackConnectorSlug, ensureChannel, type SlackConnectorSlug } from "#setup/scaffold/index.js";
import { inspectSlackbotConnectors, provisionSlackbot, reconcileSlackUid, type SlackConnectorSelection } from "#setup/slackbot.js";
import { type SetupApplyContext, type SetupPrepareContext } from "../types.js";
export interface SlackSetupDeps {
    deriveSlackConnectorSlug: typeof deriveSlackConnectorSlug;
    ensureChannel: typeof ensureChannel;
    inspectConnectors: typeof inspectSlackbotConnectors;
    provisionSlackbot: typeof provisionSlackbot;
    reconcileSlackUid: typeof reconcileSlackUid;
}
type SlackSetupPlan = {
    credentials: "environment";
    slug: SlackConnectorSlug;
} | {
    credentials: "vercel-connect";
    slug: SlackConnectorSlug;
    project: VercelProjectReference;
    connector: SlackConnectorSelection;
};
export declare function prepareSlackSetup(context: SetupPrepareContext, deps?: SlackSetupDeps): Promise<SlackSetupPlan>;
export declare function applySlackSetup(plan: SlackSetupPlan, context: SetupApplyContext, deps?: SlackSetupDeps): Promise<{
    facts: {
        label: string;
        value: string;
        kind: "url";
    }[];
    deploymentRequired: true;
}>;
export declare const SLACK_SETUP: import("../types.js").SetupIntegration;
export {};
