/**
 * Slack `block_actions` + `view_submission` wire handling. It decodes and
 * authorizes framework HITL responses, opens freeform modals inline before
 * Slack's trigger expires, and forwards user-owned actions to `onInteraction`.
 */
import { type SlackBlockActionsPayload } from "#compiled/@chat-adapter/slack/webhook.js";
import type { SlackChannelConfig, SlackChannelState, SlackInteractionAction } from "#public/channels/slack/slackChannel.js";
import type { ChannelFrom, ChannelResolveSession } from "#channel/channel-operations.js";
/**
 * Decoded view of a Slack `block_actions` payload. Returned by
 * {@link parseBlockActionsPayload} and read by the handler.
 */
interface ParsedBlockActionsPayload {
    readonly actions: SlackInteractionAction[];
    readonly channelId: string;
    readonly threadTs: string;
    readonly teamId: string | undefined;
    /**
     * The full block list off the clicked message. Preserved on the
     * answered-card update so the original prompt stays visible after the
     * interactive controls are stripped.
     */
    readonly messageBlocks: readonly unknown[];
}
/**
 * Decodes a Slack `block_actions` payload into a {@link ParsedBlockActionsPayload}.
 * Returns `null` for payloads that don't carry the channel/thread
 * metadata the handler needs.
 */
export declare function parseBlockActionsPayload(body: Record<string, unknown> | SlackBlockActionsPayload): ParsedBlockActionsPayload | null;
/** Channel-supplied dependencies for {@link handleInteractionPost}. */
export interface InteractionHandlerDeps {
    readonly config: SlackChannelConfig;
    readonly onInputResponse: NonNullable<SlackChannelConfig["onInputResponse"]>;
}
/**
 * Entry point for Slack's form-encoded interactivity endpoint. Routes
 * `view_submission` payloads to the freeform-answer flow, intercepts
 * "Type your answer" button clicks to open a modal, resolves
 * framework HITL clicks through `onInputResponse` to the parked session,
 * and forwards anything else to `config.onInteraction`.
 */
export declare function handleInteractionPost(rawBody: string, ctx: {
    from: ChannelFrom<SlackChannelState>;
    resolveSession: ChannelResolveSession;
    waitUntil: (task: Promise<unknown>) => void;
}, deps: InteractionHandlerDeps): Promise<Response>;
export type { ParsedBlockActionsPayload };
