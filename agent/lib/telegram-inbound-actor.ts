/**
 * Verified Telegram inbound actor projection.
 *
 * Exports:
 * - `TelegramInboundActor`: explicit user or channel identity derived before authorization.
 * - `TelegramTimelineActorKind`: persisted timeline actor discriminator.
 * - `telegramInboundActor`: fail-closed classifier for human, bot, and channel-authored messages.
 * - `TELEGRAM_SENDER_TAG_MAX_CHARACTERS`, `telegramSenderTag`: the member tag shown next to the sender.
 *
 * Key constructs:
 * - Bot API 10.2 delivers other bots' group messages once Bot-to-Bot Communication Mode is on, so a
 *   bot sender is a real participant of the timeline. It never carries family identity or rights.
 * - A supergroup member tag («Батя», «Token Burner») comes in each message's `sender_tag`. It is
 *   chosen by the group, changes over time and is not unique, so it is kept per message and never
 *   identifies anyone; it only lets Mia follow «спроси у Бати».
 */
import type { TelegramMessage } from "eve/channels/telegram";
import { clipText, flattenDisplayText } from "./display-text.js";
import { asRecord as record, nonEmptyText } from "./json-value.js";

export type TelegramTimelineActorKind =
  | "agent_self"
  | "telegram_bot"
  | "telegram_channel"
  | "user";
export type TelegramActorKind = "telegram_bot" | "telegram_channel" | "telegram_user";

export interface TelegramInboundActor {
  actorId: string;
  displayName: string | null;
  id: string;
  kind: TelegramActorKind;
  timelineKind: Exclude<TelegramTimelineActorKind, "agent_self">;
  username: string | null;
}

// Telegram Bot API uses this fixed fake user for messages posted on behalf of a channel.
const TELEGRAM_CHANNEL_BOT_ID = "136817688";

function exactIdentifier(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?\d+$/u.test(value)) return value;
  return null;
}

function userDisplayName(message: TelegramMessage): string | null {
  const sender = message.from;
  if (!sender) return null;
  const name = [sender.firstName, sender.lastName].filter(Boolean).join(" ").trim();
  return name || sender.username || null;
}

export function telegramInboundActor(message: TelegramMessage): TelegramInboundActor | null {
  const sender = message.from;
  const senderChat = record(message.raw.sender_chat);

  // Human messages must not carry a second, conflicting visible Telegram sender.
  if (sender && !sender.isBot) {
    if (senderChat !== null) return null;
    return {
      actorId: `telegram:${sender.id}`,
      displayName: userDisplayName(message),
      id: sender.id,
      kind: "telegram_user",
      timelineKind: "user",
      username: sender.username ?? null,
    };
  }

  // Another bot writing in the group: it has no sender_chat and is not the channel pseudo-user.
  // Its message is ordinary untrusted timeline content; identity and rights stay unavailable.
  if (sender?.isBot && senderChat === null && sender.id !== TELEGRAM_CHANNEL_BOT_ID) {
    return {
      actorId: `telegram-bot:${sender.id}`,
      displayName: userDisplayName(message),
      id: sender.id,
      kind: "telegram_bot",
      timelineKind: "telegram_bot",
      username: sender.username ?? null,
    };
  }

  // Telegram represents channel-authored supergroup posts as Channel_Bot plus raw sender_chat.
  // Both identities must agree with the verified webhook before the channel is trusted as actor.
  if (!sender?.isBot || !senderChat ||
    (message.chat.type !== "group" && message.chat.type !== "supergroup") ||
    senderChat.type !== "channel") return null;
  const rawSender = record(message.raw.from);
  const senderChatId = exactIdentifier(senderChat.id);
  const title = nonEmptyText(senderChat.title);
  if (!rawSender || sender.id !== TELEGRAM_CHANNEL_BOT_ID || rawSender.is_bot !== true ||
    exactIdentifier(rawSender.id) !== sender.id ||
    !senderChatId?.startsWith("-") || !title) return null;

  return {
    actorId: `telegram-channel:${senderChatId}`,
    displayName: title,
    id: senderChatId,
    kind: "telegram_channel",
    timelineKind: "telegram_channel",
    username: nonEmptyText(senderChat.username),
  };
}

export const TELEGRAM_SENDER_TAG_MAX_CHARACTERS = 64;

export function telegramSenderTag(message: Pick<TelegramMessage, "raw">): string | null {
  const tag = message.raw.sender_tag;
  if (typeof tag !== "string") return null;
  const flat = flattenDisplayText(tag);
  return flat ? clipText(flat, TELEGRAM_SENDER_TAG_MAX_CHARACTERS) : null;
}
