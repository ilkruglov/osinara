import type { ChannelFrom } from "#channel/channel-operations.js";
import type { GitHubBotNameResolver } from "#public/channels/github/auth.js";
import { type GitHubCheckRunWebhookEvent, type GitHubCheckSuiteWebhookEvent, type GitHubIssueCommentEvent, type GitHubIssueWebhookEvent, type GitHubPullRequestReviewCommentEvent, type GitHubPullRequestWebhookEvent, type GitHubWorkflowRunWebhookEvent } from "#public/channels/github/inbound.js";
import { type GitHubChannelState } from "#public/channels/github/state.js";
import type { GitHubChannelConfig } from "#public/channels/github/githubChannel.js";
/** Dispatches a bot-directed issue or PR timeline comment into the runtime. */
export declare function dispatchIssueComment(input: {
    readonly botName: GitHubBotNameResolver;
    readonly config: GitHubChannelConfig;
    readonly event: GitHubIssueCommentEvent;
    readonly handler: NonNullable<GitHubChannelConfig["onComment"]>;
    readonly from: ChannelFrom<GitHubChannelState>;
}): Promise<void>;
/** Dispatches a bot-directed inline pull-request review comment. */
export declare function dispatchPullRequestReviewComment(input: {
    readonly botName: GitHubBotNameResolver;
    readonly config: GitHubChannelConfig;
    readonly event: GitHubPullRequestReviewCommentEvent;
    readonly handler: NonNullable<GitHubChannelConfig["onComment"]>;
    readonly from: ChannelFrom<GitHubChannelState>;
}): Promise<void>;
/** Dispatches an opt-in issue webhook event into the runtime. */
export declare function dispatchIssue(input: {
    readonly config: GitHubChannelConfig;
    readonly event: GitHubIssueWebhookEvent;
    readonly handler: NonNullable<GitHubChannelConfig["onIssue"]>;
    readonly from: ChannelFrom<GitHubChannelState>;
}): Promise<void>;
/** Dispatches an opt-in pull-request webhook event into the runtime. */
export declare function dispatchPullRequest(input: {
    readonly config: GitHubChannelConfig;
    readonly event: GitHubPullRequestWebhookEvent;
    readonly handler: NonNullable<GitHubChannelConfig["onPullRequest"]>;
    readonly from: ChannelFrom<GitHubChannelState>;
}): Promise<void>;
/** Dispatches an opt-in check-suite webhook event into the runtime. */
export declare function dispatchCheckSuite(input: {
    readonly config: GitHubChannelConfig;
    readonly event: GitHubCheckSuiteWebhookEvent;
    readonly handler: NonNullable<GitHubChannelConfig["onCheckSuite"]>;
    readonly from: ChannelFrom<GitHubChannelState>;
}): Promise<void>;
/** Dispatches an opt-in check-run webhook event into the runtime. */
export declare function dispatchCheckRun(input: {
    readonly config: GitHubChannelConfig;
    readonly event: GitHubCheckRunWebhookEvent;
    readonly handler: NonNullable<GitHubChannelConfig["onCheckRun"]>;
    readonly from: ChannelFrom<GitHubChannelState>;
}): Promise<void>;
/** Dispatches an opt-in workflow-run webhook event into the runtime. */
export declare function dispatchWorkflowRun(input: {
    readonly config: GitHubChannelConfig;
    readonly event: GitHubWorkflowRunWebhookEvent;
    readonly handler: NonNullable<GitHubChannelConfig["onWorkflowRun"]>;
    readonly from: ChannelFrom<GitHubChannelState>;
}): Promise<void>;
