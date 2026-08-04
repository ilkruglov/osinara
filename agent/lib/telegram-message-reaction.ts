/**
 * Telegram current-message reaction delivery.
 *
 * Exports:
 * - `TelegramMessageReactionEmoji`: globally permitted model-selected reactions.
 * - `TelegramMessageReactionResult`: applied or provider-restricted delivery outcome.
 * - `isTelegramMessageReactionEmoji`: strict reaction directive allowlist guard.
 * - `setTelegramMessageReaction`: confirmed Bot API reaction on a verified inbound message.
 */
import type { TelegramHandle } from "eve/channels/telegram";

import { AppError } from "./app-error.js";

const TELEGRAM_MESSAGE_REACTION_EMOJIS = [
  "👍",
  "👎",
  "👌",
  "❤",
  "🤣",
  "🎉",
  "😢",
  "👀",
  "🖕",
] as const;
const TELEGRAM_MESSAGE_ID_PATTERN = /^[1-9]\d*$/u;
const TELEGRAM_REACTION_DECLINED_STATUSES = new Set([400, 403]);

export type TelegramMessageReactionResult = "applied" | "unavailable";

export type TelegramMessageReactionEmoji =
  (typeof TELEGRAM_MESSAGE_REACTION_EMOJIS)[number];

export function isTelegramMessageReactionEmoji(
  value: string,
): value is TelegramMessageReactionEmoji {
  return (TELEGRAM_MESSAGE_REACTION_EMOJIS as readonly string[]).includes(value);
}

export async function setTelegramMessageReaction(
  telegram: Pick<TelegramHandle, "chatId" | "request">,
  messageId: string,
  emoji: TelegramMessageReactionEmoji,
): Promise<TelegramMessageReactionResult> {
  if (!TELEGRAM_MESSAGE_ID_PATTERN.test(messageId) || !Number.isSafeInteger(Number(messageId))) {
    throw new AppError(
      "AGENT_TELEGRAM_REACTION_TARGET_INVALID",
      "Telegram передал некорректное сообщение для реакции",
    );
  }

  // The exact channel context and verified inbound message are the only reaction target.
  let response;
  try {
    response = await telegram.request("setMessageReaction", {
      chat_id: telegram.chatId,
      is_big: false,
      message_id: Number(messageId),
      reaction: [{ emoji, type: "emoji" }],
    });
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_TELEGRAM_REACTION_DELIVERY_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
      method: "setMessageReaction",
    }));
    if (error instanceof Error) {
      Object.defineProperty(error, "message", {
        configurable: true,
        value: `AGENT_TELEGRAM_REACTION_DELIVERY_FAILED: ${error.message}`,
        writable: true,
      });
    }
    throw error;
  }

  const body = response.body as { ok?: unknown; result?: unknown } | null;
  if (response.ok && body?.ok === true && body.result === true) return "applied";

  // Disabled or restricted chat reactions are an expected presentation limitation, not turn failure.
  if (body?.ok === false && TELEGRAM_REACTION_DECLINED_STATUSES.has(response.status)) {
    console.error(JSON.stringify({
      code: "AGENT_TELEGRAM_REACTION_UNAVAILABLE",
      method: "setMessageReaction",
      providerStatus: response.status,
    }));
    return "unavailable";
  }

  console.error(JSON.stringify({
    code: "AGENT_TELEGRAM_REACTION_DELIVERY_FAILED",
    method: "setMessageReaction",
    providerStatus: response.status,
  }));
  throw new AppError(
    "AGENT_TELEGRAM_REACTION_DELIVERY_FAILED",
    "Telegram не принял реакцию. Проверьте, разрешены ли реакции в этом чате",
  );
}
