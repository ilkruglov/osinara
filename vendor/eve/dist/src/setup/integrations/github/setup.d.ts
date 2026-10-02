import type { VercelProjectReference } from "#setup/project-resolution.js";
import { deriveSlackConnectorSlug } from "#setup/scaffold/index.js";
import { writeTextFile } from "#setup/scaffold/files.js";
import { type SetupApplyContext, type SetupPrepareContext } from "../types.js";
import { provisionGitHubConnector } from "./connect.js";
export interface GitHubSetupDeps {
    deriveConnectorSlug: typeof deriveSlackConnectorSlug;
    provisionConnector: typeof provisionGitHubConnector;
    writeTextFile: typeof writeTextFile;
}
declare const GITHUB_EVENT_OPTIONS: readonly [{
    readonly id: "issue_comment";
    readonly label: "New issue and PR comments";
    readonly value: "issue_comment";
    readonly hint: "Reply when a new timeline comment includes `@<bot-name>`.";
}, {
    readonly id: "pull_request_review_comment";
    readonly label: "New inline PR review comments";
    readonly value: "pull_request_review_comment";
    readonly hint: "Reply when a new inline review comment includes `@<bot-name>`.";
}, {
    readonly id: "issues";
    readonly label: "New issues";
    readonly value: "issues";
    readonly hint: "Add comments to new issues.";
}, {
    readonly id: "pull_request";
    readonly label: "New PRs";
    readonly value: "pull_request";
    readonly hint: "Add comments to new pull requests.";
}];
type GitHubWebhookEvent = (typeof GITHUB_EVENT_OPTIONS)[number]["value"];
export interface GitHubSetupPlan {
    events: readonly GitHubWebhookEvent[];
    project: VercelProjectReference;
    slug: string;
}
export declare function prepareGitHubSetup(context: SetupPrepareContext, deps?: GitHubSetupDeps): Promise<GitHubSetupPlan>;
export declare function applyGitHubSetup(plan: GitHubSetupPlan, context: SetupApplyContext, deps?: GitHubSetupDeps): Promise<{
    facts: never[];
    deploymentRequired: true;
}>;
export declare const GITHUB_SETUP: import("../types.js").SetupIntegration;
export {};
