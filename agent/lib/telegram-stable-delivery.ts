/**
 * Telegram delivery that preserves Eve's stable continuation hook.
 *
 * Exports:
 * - `postTelegramMessageWithoutContinuationChange`: sends one short service message via the raw
 *   Bot API handle and returns its verified message ID without mutating channel anchor state.
 */
import type { TelegramEventContext } from "eve/channels/telegram";

import { AppError } from "./app-error.js";

type TelegramJsonValue =
  | boolean
  | null
  | number
  | string
  | { readonly [key: string]: TelegramJsonValue }
  | readonly TelegramJsonValue[];

interface StableTelegramMessage {
  readonly reply_markup?: Readonly<Record<string, unknown>>;
  readonly reply_parameters?: Readonly<Record<string, unknown>>;
  readonly text: string;
}

function telegramJson(value: unknown): TelegramJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) return value;
  if (Array.isArray(value)) return value.map(telegramJson);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, telegramJson(item)]));
  }
  throw new AppError(
    "AGENT_TELEGRAM_DELIVERY_PAYLOAD_INVALID",
    "Не удалось подготовить служебное сообщение для Telegram",
  );
}

export async function postTelegramMessageWithoutContinuationChange(
  channel: TelegramEventContext,
  message: string | StableTelegramMessage,
): Promise<string> {
  const chatId = channel.state.chatId;
  if (!chatId) {
    throw new AppError(
      "AGENT_TELEGRAM_DELIVERY_CONTEXT_INVALID",
      "Не удалось определить Telegram-чат для отправки сообщения",
    );
  }

  // `telegram.post` re-keys Eve as a side effect. Raw `sendMessage` deliberately bypasses that
  // adapter mutation while retaining Eve's authenticated Telegram API transport.
  const payload = typeof message === "string"
    ? { text: message }
    : {
        ...(message.reply_markup === undefined
          ? {}
          : { reply_markup: telegramJson(message.reply_markup) }),
        ...(message.reply_parameters === undefined
          ? {}
          : { reply_parameters: telegramJson(message.reply_parameters) }),
        text: message.text,
      };
  const response = await channel.telegram.request("sendMessage", {
    chat_id: chatId,
    ...(channel.state.messageThreadId === null
      ? {}
      : { message_thread_id: channel.state.messageThreadId }),
    ...payload,
  });
  const body = response.body as {
    ok?: unknown;
    result?: { message_id?: unknown };
  };
  if (!response.ok || body.ok !== true) {
    throw new AppError(
      "AGENT_TELEGRAM_MESSAGE_DELIVERY_FAILED",
      "Telegram не принял обычное сообщение. Попробуйте повторить запрос",
    );
  }
  const messageId = body.result?.message_id;
  if (Number.isSafeInteger(messageId) && Number(messageId) > 0) {
    return String(messageId);
  }
  throw new AppError(
    "AGENT_TELEGRAM_MESSAGE_DELIVERY_AMBIGUOUS",
    "Telegram принял запрос, но не подтвердил идентификатор обычного сообщения",
  );
}
