/**
 * The webhook-time gate of a whisper.
 *
 * Exports:
 * - `WHISPER_PLACEHOLDER_TEXT`, `WHISPER_USAGE_HINT`: what the author sees before the answer.
 * - `createTelegramWhisperGate`: `open` authorizes, sends the placeholder and records it, `close`
 *   records it closed and removes it.
 * - `telegramWhisperGate`: production gate.
 *
 * Key construct:
 * - Telegram lets the bot reply to an ephemeral command only within 15 seconds of it (unless the
 *   bot is a chat administrator), while the turn may wait in its queue longer. So the gate replies
 *   right in the webhook, before the ACK, with a placeholder the turn later edits into the answer;
 *   an edit has no such window. Refused authors and unregistered groups get nothing, as in the chat.
 * - The placeholder is recorded with its update before the update is queued, so the minute sweep
 *   finds one nothing will finish (`whisper-placeholder-sweep.ts`). A placeholder that could not be
 *   recorded is removed at once and the webhook fails: Telegram delivers the update again.
 */
import type { TelegramMessage } from "eve/channels/telegram";

import { telegramRepository, type TelegramRepository } from "../telegram-repository.js";
import { telegramProviderDescription } from "../telegram-reachability/recipient-failure.js";
import { authorizeTelegramWhisper } from "./telegram-whisper-access.js";
import {
  deleteTelegramWhisperMessage,
  editTelegramWhisperMessage,
  sendTelegramWhisperReply,
  type TelegramWhisperSendResult,
} from "./telegram-whisper-api.js";
import { parseTelegramWhisperCommand, type TelegramWhisperMarker } from "./telegram-whisper.js";
import {
  whisperPlaceholderRepository,
  type WhisperPlaceholderKey,
  type WhisperPlaceholderRepository,
} from "./whisper-placeholder-repository.js";
import {
  writeWhisperPlaceholder,
  type WhisperPlaceholderApi,
} from "./whisper-placeholder-writer.js";

export const WHISPER_PLACEHOLDER_TEXT = "Думаю… Вопрос и ответ видите только вы.";
export const WHISPER_USAGE_HINT =
  "Напишите вопрос после /whisper, например: /whisper о чём они спорят? Вопрос и ответ увидите только вы.";

interface WhisperGateApi extends WhisperPlaceholderApi {
  reply(input: {
    chatId: string;
    ephemeralMessageId: number;
    messageThreadId: number | null;
    receiverUserId: string;
    text: string;
  }): Promise<TelegramWhisperSendResult>;
}

export interface TelegramWhisperGate {
  close(chatId: string, marker: TelegramWhisperMarker): Promise<void>;
  /** The marker of the placeholder sent and recorded for `updateId`, or null when nothing was queued. */
  open(message: TelegramMessage, updateId: string): Promise<TelegramWhisperMarker | null>;
}

export function createTelegramWhisperGate(dependencies: {
  api: WhisperGateApi;
  botUsername: string;
  placeholders: WhisperPlaceholderRepository;
  telegram: Pick<TelegramRepository, "findGroup" | "findIdentity">;
}): TelegramWhisperGate {
  // Removal of a placeholder nothing records: the record failed, or it was purged long ago.
  async function removeUnrecorded(key: WhisperPlaceholderKey): Promise<void> {
    try {
      const removed = await dependencies.api.delete(key);
      if (!removed.ok) {
        console.warn(
          JSON.stringify({
            code: "AGENT_TELEGRAM_WHISPER_CLOSE_FAILED",
            providerDescription: telegramProviderDescription(removed.body),
            providerStatus: removed.status,
          }),
        );
      }
    } catch (error) {
      console.warn(
        JSON.stringify({
          code: "AGENT_TELEGRAM_WHISPER_CLOSE_FAILED",
          error: error instanceof Error ? error.name : "UnknownError",
        }),
      );
    }
  }

  return {
    async close(chatId, marker) {
      const key = {
        chatId,
        placeholderMessageId: marker.placeholderMessageId,
        receiverUserId: marker.receiverUserId,
      };
      const written = await writeWhisperPlaceholder(
        key,
        { content: { remove: true }, from: ["open", "progress"], to: "closed" },
        { api: dependencies.api, placeholders: dependencies.placeholders },
      );
      if (written === "missing") await removeUnrecorded(key);
    },

    async open(message, updateId) {
      const command = parseTelegramWhisperCommand(message, dependencies.botUsername);
      if (!command) return null;
      if (!(await authorizeTelegramWhisper(dependencies.telegram, message, command.receiverUserId)))
        return null;
      const target = {
        chatId: message.chat.id,
        ephemeralMessageId: command.ephemeralMessageId,
        messageThreadId: message.messageThreadId ?? null,
        receiverUserId: command.receiverUserId,
      };
      if (command.question === "") {
        await dependencies.api.reply({ ...target, text: WHISPER_USAGE_HINT });
        return null;
      }
      const placeholder = await dependencies.api.reply({
        ...target,
        text: WHISPER_PLACEHOLDER_TEXT,
      });
      if (!placeholder.ok) {
        // Past the window there is no way to answer this whisper; nothing is queued for it.
        console.warn(
          JSON.stringify({
            code: "AGENT_TELEGRAM_WHISPER_PLACEHOLDER_FAILED",
            providerDescription: telegramProviderDescription(placeholder.body),
            providerStatus: placeholder.status,
          }),
        );
        return null;
      }
      const key = {
        chatId: message.chat.id,
        placeholderMessageId: placeholder.placeholderMessageId,
        receiverUserId: command.receiverUserId,
      };
      try {
        await dependencies.placeholders.record({ ...key, updateId });
      } catch (error) {
        await removeUnrecorded(key);
        throw error;
      }
      return {
        ephemeralMessageId: command.ephemeralMessageId,
        placeholderMessageId: placeholder.placeholderMessageId,
        receiverUserId: command.receiverUserId,
      };
    },
  };
}

export const telegramWhisperGate = createTelegramWhisperGate({
  api: {
    delete: deleteTelegramWhisperMessage,
    edit: editTelegramWhisperMessage,
    reply: sendTelegramWhisperReply,
  },
  botUsername: process.env.TELEGRAM_BOT_USERNAME ?? "",
  placeholders: whisperPlaceholderRepository,
  telegram: telegramRepository,
});
