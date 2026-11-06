/**
 * The short reply a person gets when a message of theirs was not processed.
 *
 * Exports:
 * - `failureNoticeText`: the person-facing sentence of a failure, without its stable code prefix.
 * - `sendTelegramFailureNotice`: replies to that message in its private chat or whisper placeholder.
 *
 * Key construct:
 * - Ingress failure texts are written for people («отправьте запись повторно»), but until
 *   2 October 2026 they only reached the log: two messages failed after a restart and the person saw
 *   silence. Private chats only; a group is not told about one member's lost message, while a
 *   failed whisper is told in the placeholder its author alone sees, unless that placeholder already
 *   shows the answer (a drain after a restart may refuse an update whose turn did answer).
 */
import { sendTelegramMessage, type TelegramUpdate } from "eve/channels/telegram";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../config.js";
import { AppError } from "./app-error.js";
import { withRequestTimeout } from "./request-signal.js";
import { readTelegramWhisperMarker } from "./whisper/telegram-whisper.js";
import {
  PRODUCTION_WHISPER_PLACEHOLDER_DEPENDENCIES,
  writeWhisperPlaceholder,
  type WhisperPlaceholderDependencies,
} from "./whisper/whisper-placeholder-writer.js";

export function failureNoticeText(failure: { code: string; message: string }): string {
  const sentence = failure.message.replace(/^[A-Z][A-Z0-9_]+:\s*/u, "").trim();
  return sentence || "Не удалось обработать это сообщение. Отправьте его ещё раз";
}

export async function sendTelegramFailureNotice(
  update: TelegramUpdate,
  failure: { code: string; message: string },
  whisperDependencies: WhisperPlaceholderDependencies = PRODUCTION_WHISPER_PLACEHOLDER_DEPENDENCIES,
): Promise<void> {
  if (update.kind !== "message") return;
  // A whisper's placeholder is seen by its author alone, so a failure there is told as in a private chat.
  const whisper = readTelegramWhisperMarker(update.message.raw);
  if (whisper) {
    await writeWhisperPlaceholder(
      { chatId: update.message.chat.id, placeholderMessageId: whisper.placeholderMessageId, receiverUserId: whisper.receiverUserId },
      { content: { format: "plain", text: failureNoticeText(failure) }, from: ["open", "progress"], to: "failed" },
      whisperDependencies,
    );
    return;
  }
  if (update.message.chat.type !== "private") return;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new AppError("AGENT_TELEGRAM_CONFIG_MISSING", "Не задан токен Telegram для уведомления о сбое");
  }
  await sendTelegramMessage({
    body: {
      reply_parameters: { allow_sending_without_reply: true, message_id: Number(update.message.messageId) },
      text: failureNoticeText(failure),
    },
    chatId: update.message.chat.id,
    credentials: { botToken },
    fetch: withRequestTimeout((request, init) => fetch(request, init), TELEGRAM_API_REQUEST_TIMEOUT_MS),
  });
}
