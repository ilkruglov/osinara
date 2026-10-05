import type { TelegramInstrumentationMetadata } from "#public/channels/telegram/index.js";
import type { SessionAuthContext, TurnPolicy } from "#channel/types.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { ChannelContinuationOps } from "#public/definitions/channel.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { type TelegramApiOptions, type TelegramApiResponse, type TelegramCredentials, type TelegramMessageBody, type TelegramMessageResult } from "#public/channels/telegram/api.js";
import { type TelegramHitlState } from "#public/channels/telegram/hitl.js";
import { type TelegramCallbackQuery, type TelegramChatType, type TelegramMessage, type TelegramUpdate } from "#public/channels/telegram/inbound.js";
import type { Session } from "#channel/session.js";
import { type UploadPolicyInput } from "#public/channels/upload-policy.js";
import { type TelegramWebhookSecretToken, type TelegramWebhookVerifier } from "#public/channels/telegram/verify.js";
import { type Channel } from "#public/definitions/channel.js";
import { type JsonObject } from "#shared/json.js";
type EventData<T extends UnstampedMessageStreamEvent["type"]> = Extract<UnstampedMessageStreamEvent, {
    type: T;
}> extends {
    data: infer D;
} ? D : undefined;
/** Minimal Telegram context (only `telegram`, no `state` or session ops), passed to `onMessage` and `onCallbackQuery` hooks before a session exists. Event handlers receive the richer {@link TelegramEventContext}. */
export interface TelegramContext {
    readonly telegram: TelegramHandle;
}
/** Channel-owned Telegram context returned by `context()`. */
export interface TelegramChannelContext extends TelegramContext {
    state: TelegramChannelState;
}
/** Event-handler Telegram context, including continuation routing. */
export interface TelegramEventContext extends TelegramChannelContext, ChannelContinuationOps {
}
/** JSON-serializable Telegram channel state. */
export interface TelegramChannelState extends TelegramHitlState {
    /** Telegram bot username used for group mention detection, when configured. */
    botUsername?: string | null;
    /** Telegram chat id. */
    chatId: string | null;
    /** Telegram chat type, when known from an inbound update. */
    chatType: TelegramChatType | null;
    /** Group/supergroup conversation anchor message id. */
    conversationId: string | null;
    /** Forum topic id, when known. */
    messageThreadId: number | null;
    /** Telegram user id that triggered the current session/turn. */
    triggeringUserId?: string | null;
}
/** Telegram channel credentials. `webhookVerifier` is a custom inbound webhook verifier for forwarded webhooks. */
export interface TelegramChannelCredentials extends TelegramCredentials {
    /** Webhook secret token configured via setWebhook. Falls back to `TELEGRAM_WEBHOOK_SECRET_TOKEN` when neither this nor `webhookVerifier` is set. */
    readonly webhookSecretToken?: TelegramWebhookSecretToken;
    readonly webhookVerifier?: TelegramWebhookVerifier;
}
/** Target for `receive(telegram, { target })` proactive sessions. `chatId` is required. `conversationId` resumes an existing thread; `initialMessage` posts a seed message and starts a new thread from it. The two are mutually exclusive: supplying both throws. */
export interface TelegramReceiveTarget {
    readonly chatId: number | string;
    readonly conversationId?: number | string;
    readonly initialMessage?: string | TelegramMessageBody;
    readonly messageThreadId?: number;
}
/** Result of an inbound Telegram message hook. Return `null` to drop the update. */
export type TelegramInboundResult = {
    readonly auth: SessionAuthContext | null;
    readonly context?: readonly string[];
    readonly continuationToken?: string;
    readonly message?: string;
    readonly replyHandling?: "message";
    /** Overrides the workflow run title without changing the message sent to the model. */
    readonly title?: string;
} | null;
/** Sync or async {@link TelegramInboundResult}. */
export type TelegramInboundResultOrPromise = TelegramInboundResult | Promise<TelegramInboundResult>;
type TelegramEventHandler<T extends UnstampedMessageStreamEvent["type"]> = (data: EventData<T>, channel: TelegramEventContext, ctx: SessionContext) => void | Promise<void>;
type TelegramSessionFailedHandler = (data: EventData<"session.failed">, channel: TelegramEventContext) => void | Promise<void>;
/** Per-event handlers for `telegramChannel({ events })`. Each entry overrides the built-in default (handlers merge over {@link defaultEvents}). `session.failed` receives `(data, channel)` and exposes the ID as `data.sessionId`; all others also receive the {@link SessionContext}. */
export interface TelegramChannelEvents {
    readonly "turn.started"?: TelegramEventHandler<"turn.started">;
    readonly "actions.requested"?: TelegramEventHandler<"actions.requested">;
    readonly "action.partial"?: TelegramEventHandler<"action.partial">;
    readonly "action.result"?: TelegramEventHandler<"action.result">;
    readonly "message.completed"?: TelegramEventHandler<"message.completed">;
    readonly "message.appended"?: TelegramEventHandler<"message.appended">;
    readonly "input.requested"?: TelegramEventHandler<"input.requested">;
    readonly "turn.failed"?: TelegramEventHandler<"turn.failed">;
    readonly "turn.completed"?: TelegramEventHandler<"turn.completed">;
    readonly "turn.cancelled"?: TelegramEventHandler<"turn.cancelled">;
    readonly "session.failed"?: TelegramSessionFailedHandler;
    readonly "session.completed"?: TelegramEventHandler<"session.completed">;
    readonly "session.waiting"?: TelegramEventHandler<"session.waiting">;
    readonly "authorization.required"?: TelegramEventHandler<"authorization.required">;
    readonly "authorization.completed"?: TelegramEventHandler<"authorization.completed">;
}
/** Verified Telegram ingress hook context for durable application queues. */
export interface TelegramVerifiedUpdateContext {
    readonly raw: JsonObject;
    readonly update: TelegramUpdate;
    readonly dispatch: (update: TelegramUpdate) => Promise<Session | null | undefined>;
    readonly waitUntil: (task: Promise<unknown>) => void;
}
/** Internal drain hook context using the native verified Telegram dispatcher. */
export interface TelegramDrainContext {
    readonly dispatch: (update: TelegramUpdate) => Promise<Session | null | undefined>;
    readonly waitUntil: (task: Promise<unknown>) => void;
}
/** Application-authenticated result for a Telegram HITL callback. */
export type TelegramHitlCallbackResult = {
    readonly acknowledgementText?: string;
    readonly auth: SessionAuthContext | null;
    readonly continuationToken?: string;
    /** Answers for every request of the claimed prompt; defaults to the tapped callback alone. */
    readonly inputResponses?: readonly { readonly optionId?: string; readonly requestId: string; readonly text?: string; }[];
} | null;
/** Configuration for {@link telegramChannel}. */
export interface TelegramChannelConfig {
    /** API transport overrides (base URLs, custom fetch). Credentials are supplied separately via `credentials`. */
    readonly api?: Omit<TelegramApiOptions, "credentials">;
    /** Bot username (without `@`) used to detect mentions and `/command@bot` in group chats. */
    readonly botUsername?: string;
    /** Bot token and inbound webhook verification settings. */
    readonly credentials?: TelegramChannelCredentials;
    /** Per-event handler overrides. See {@link TelegramChannelEvents}. */
    readonly events?: TelegramChannelEvents;
    /** Handler for non-HITL callback queries. */
    readonly onCallbackQuery?: (ctx: TelegramContext, query: TelegramCallbackQuery) => void | Promise<void>;
    /** Optional internal endpoint that resumes persisted ingress after process restarts. */
    readonly drainRoute?: string;
    /** Osinara: verifies the drain route with its own token instead of the webhook secret Telegram holds. */
    readonly drainCredentials?: Pick<TelegramChannelCredentials, "webhookSecretToken">;
    /** Drains persisted updates through the native verified dispatcher. */
    readonly onDrain?: (context: TelegramDrainContext) => Response | Promise<Response>;
    /** Resolves a versioned token when no authenticated HITL callback hook is configured. */
    readonly resolveContinuationToken?: (baseToken: string) => string | Promise<string>;
    /** Authenticates the verified Telegram user before a HITL callback resumes Eve. */
    readonly onHitlCallbackQuery?: (ctx: TelegramContext, query: TelegramCallbackQuery, continuationToken: string) => TelegramHitlCallbackResult | Promise<TelegramHitlCallbackResult>;
    /** Runs after webhook verification and parsing, before native dispatch. */
    readonly onVerifiedUpdate?: (context: TelegramVerifiedUpdateContext) => Response | Promise<Response>;
    /** Inbound message hook. Defaults to Telegram user auth and dispatch gating. */
    readonly onMessage?: (ctx: TelegramContext, message: TelegramMessage) => TelegramInboundResultOrPromise;
    /** Override the default webhook route path (`/eve/v1/telegram`). */
    readonly route?: string;
    /** Policy for accepted messages that arrive while a turn is active. */
    readonly turnPolicy?: TurnPolicy;
    /** Inbound upload policy for Telegram photos and documents. */
    readonly uploadPolicy?: UploadPolicyInput;
}
/** Low-level Telegram handle on every channel context as `ctx.telegram`. `request` issues a raw Bot API call by method name and returns the decoded response. `post` and `sendMessage` are identical: each sends a message, splitting text over the 4096-character cap into multiple messages and resolving to the first. `startTyping` sends a chat action (defaults to `typing`) and never throws: it logs and swallows failures. */
export interface TelegramHandle {
    readonly botUsername: string | undefined;
    readonly chatId: string;
    readonly chatType: TelegramChatType | undefined;
    readonly conversationId: string | undefined;
    readonly messageThreadId: number | undefined;
    request(method: string, body?: JsonObject): Promise<TelegramApiResponse>;
    post(message: string | TelegramMessageBody): Promise<TelegramMessageResult>;
    sendMessage(message: string | TelegramMessageBody): Promise<TelegramMessageResult>;
    startTyping(action?: string): Promise<void>;
    answerCallbackQuery(input: {
        readonly callbackQueryId: string;
        readonly showAlert?: boolean;
        readonly text?: string;
    }): Promise<TelegramApiResponse>;
    editMessageReplyMarkup(input: {
        readonly messageId: number | string;
        readonly replyMarkup?: Readonly<Record<string, unknown>>;
    }): Promise<TelegramApiResponse>;
}
/** Concrete return type of {@link telegramChannel}. */
export interface TelegramChannel extends Channel<TelegramChannelState, TelegramReceiveTarget, TelegramInstrumentationMetadata> {
}
/** Telegram channel factory for webhook updates and proactive messages. */
export declare function telegramChannel(config?: TelegramChannelConfig): TelegramChannel;
export {};
