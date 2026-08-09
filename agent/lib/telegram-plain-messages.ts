/**
 * Native ordinary Telegram text delivery.
 *
 * Export:
 * - `postTelegramPlainMessageChunk`: sends one provider-sized text chunk without parse mode.
 */
import {
  TELEGRAM_MESSAGE_TEXT_MAX_LENGTH,
  type TelegramEventContext,
} from "eve/channels/telegram";

import { AppError } from "./app-error.js";
import type { TelegramReplyParameters } from "./telegram-reply.js";
import type { SentTelegramMessage } from "./telegram-rich-messages.js";
import { postTelegramMessageWithoutContinuationChange } from "./telegram-stable-delivery.js";

export async function postTelegramPlainMessageChunk(
  text: string,
  channel: TelegramEventContext,
  replyParameters?: TelegramReplyParameters,
): Promise<SentTelegramMessage> {
  if (!text || text.length > TELEGRAM_MESSAGE_TEXT_MAX_LENGTH) {
    throw new AppError(
      "AGENT_TELEGRAM_PLAIN_MESSAGE_INPUT_INVALID",
      "Обычное сообщение превышает допустимый размер Telegram",
    );
  }

  const chatType = channel.state.chatType;
  if (!chatType) {
    throw new AppError(
      "AGENT_TELEGRAM_PLAIN_MESSAGE_CONTEXT_INVALID",
      "Не удалось определить тип Telegram-чата для обычного сообщения",
    );
  }

  // Raw stable delivery keeps Eve's canonical continuation token unchanged; aliases are registered
  // only after the durable final-delivery receipt is committed by the channel boundary.
  const messageId = await postTelegramMessageWithoutContinuationChange(channel, {
    ...(replyParameters === undefined ? {} : { reply_parameters: replyParameters }),
    text,
  });
  return { chatType, messageId };
}
