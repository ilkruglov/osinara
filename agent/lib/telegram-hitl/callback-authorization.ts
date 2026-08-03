/**
 * Telegram HITL callback authorization boundary.
 *
 * Exports:
 * - `createTelegramHitlCallbackAuthorizer`: builds an independently testable callback guard.
 * - `authorizeTelegramHitlCallback`: production guard backed by durable PostgreSQL claims.
 */
import {
  telegramContinuationToken,
  type TelegramCallbackQuery,
  type TelegramContext,
  type TelegramHitlCallbackResult,
} from "eve/channels/telegram";

import { AppError } from "../app-error.js";
import {
  telegramHitlApprovalRepository,
  type TelegramHitlApprovalRepository,
} from "./approval-repository.js";

const CALLBACK_ERRORS = {
  expired:
    "AGENT_APPROVAL_EXPIRED: Это подтверждение уже использовано или больше не действует.",
  forbidden:
    "AGENT_APPROVAL_FORBIDDEN: Подтвердить действие может только пользователь, который его запросил.",
} as const;
const TELEGRAM_MESSAGE_MAX_CHARACTERS = 4_096;

function resolvedApprovalText(result: {
  promptText: string;
  selectedOptionId: string;
  selectedOptionLabel: string;
}): string {
  const resolution = result.selectedOptionId === "approve"
    ? "Решение: Подтверждено.\nДействие передано на выполнение."
    : result.selectedOptionId === "deny"
    ? "Решение: Отклонено.\nДействие не будет выполнено."
    : `Выбран ответ: ${result.selectedOptionLabel}`;
  const promptLimit = TELEGRAM_MESSAGE_MAX_CHARACTERS - resolution.length - 2;
  const prompt = result.promptText.length <= promptLimit
    ? result.promptText
    : `${result.promptText.slice(0, promptLimit - 1).trimEnd()}…`;
  return `${prompt}\n\n${resolution}`;
}

export function createTelegramHitlCallbackAuthorizer(
  repository: Pick<TelegramHitlApprovalRepository, "claimCallback">,
) {
  return async function authorizeHitlCallback(
    ctx: TelegramContext,
    query: TelegramCallbackQuery,
    _continuationToken: string,
  ): Promise<TelegramHitlCallbackResult> {
    const message = query.message;
    const callbackData = query.data;
    if (!message || !callbackData) {
      await ctx.telegram.answerCallbackQuery({
        callbackQueryId: query.id,
        showAlert: true,
        text: CALLBACK_ERRORS.expired,
      });
      return null;
    }

    // Callback message identity is the exact durable prompt alias; private channel tokens omit it.
    const promptRoute = telegramContinuationToken({
      chatId: message.chat.id,
      conversationId: message.messageId,
      ...(message.messageThreadId === undefined ? {} : { messageThreadId: message.messageThreadId }),
    });
    // The repository atomically binds the exact button, active Eve request, and current DB role.
    const result = await repository.claimCallback({
      baseContinuationToken: promptRoute,
      callbackData,
      telegramChatId: message.chat.id,
      telegramMessageId: message.messageId,
      telegramUserId: query.from.id,
    });
    if (result.status === "authorized") {
      // Replace the exact claimed prompt before Eve resumes; an empty keyboard removes stale buttons.
      const edited = await ctx.telegram.request("editMessageText", {
        chat_id: message.chat.id,
        message_id: Number(message.messageId),
        reply_markup: { inline_keyboard: [] },
        text: resolvedApprovalText(result),
      });
      if (!edited.ok) {
        throw new AppError(
          "AGENT_APPROVAL_MESSAGE_FINALIZE_FAILED",
          "Telegram не обновил сообщение с выбранным решением. Повторите действие",
        );
      }
      return {
        acknowledgementText: "Решение сохранено",
        auth: result.auth,
        continuationToken: result.continuationToken,
      };
    }

    await ctx.telegram.answerCallbackQuery({
      callbackQueryId: query.id,
      showAlert: true,
      text: CALLBACK_ERRORS[result.status],
    });
    return null;
  };
}

export const authorizeTelegramHitlCallback = createTelegramHitlCallbackAuthorizer(
  telegramHitlApprovalRepository,
);
