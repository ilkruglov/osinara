import type { SessionAuthContext } from "#channel/types.js";
import type { SlackChannelConfig, SlackInputResponseResult, SlackInputResponseSubmission, SlackChannelState } from "#public/channels/slack/slackChannel.js";
export declare function approvalResponderStatePatch(submission: Extract<SlackInputResponseSubmission, {
    type: "block_actions";
}>, auth: SessionAuthContext | null): Partial<SlackChannelState> | undefined;
export declare function authorizeInputResponse(input: {
    readonly channelId: string;
    readonly deps: {
        readonly config: SlackChannelConfig;
        readonly onInputResponse: NonNullable<SlackChannelConfig["onInputResponse"]>;
    };
    readonly submission: SlackInputResponseSubmission;
    readonly teamId: string | null | undefined;
    readonly threadTs: string;
}): Promise<SlackInputResponseResult>;
