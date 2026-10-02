import type { SlackApiResponse } from "#public/channels/slack/api.js";
export type SlackConversationPrivacy = "private" | "public" | "unknown";
export declare function readSlackConversationPrivacy(raw: Readonly<Record<string, unknown>> | undefined): SlackConversationPrivacy;
export declare function isPrivateSlackConversation(input: {
    readonly channelId: string;
    readonly raw: Readonly<Record<string, unknown>> | undefined;
    readonly request: (operation: string, body: unknown) => Promise<SlackApiResponse>;
}): Promise<boolean>;
