/**
 * Bounded Telegram transport for severe memory-review owner alerts.
 *
 * Exports:
 * - `MemoryReviewOwnerAlertTransportError`: definite Telegram delivery rejection.
 * - `TelegramRecipientUnreachableError`: the definite rejection of a chat that can no longer receive
 *   messages, or the skip of a chat already known to be so.
 * - `createMemoryReviewOwnerAlertTransport`: injectable no-retry transport.
 * - `memoryReviewOwnerAlertTransport`: lazy production transport using the required bot token.
 *
 * Every caller of the production transport sends a message the bot starts itself (memory-review
 * alerts, the daily digest, the balance alert, the stuck-message alert), so it skips a chat marked
 * unreachable without a request. The unreachable error extends the definite rejection, so every
 * dispatcher treats it as a refusal: nothing was delivered.
 */
import { callTelegramApi } from "eve/channels/telegram";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../../config.js";
import { withRequestTimeout } from "../request-signal.js";
import { AppError } from "../app-error.js";
import {
  classifyTelegramRecipientFailure,
  TELEGRAM_RECIPIENT_UNREACHABLE_CODE,
  type TelegramRecipientUnreachableReason,
} from "../telegram-reachability/recipient-failure.js";
import { unreachableTelegramRecipient } from "../telegram-reachability/reachability-guard.js";

export class MemoryReviewOwnerAlertTransportError extends AppError {
  readonly delivery: "failed";

  constructor(delivery: "failed", code: string, message: string) {
    super(code, message);
    this.delivery = delivery;
    this.name = "MemoryReviewOwnerAlertTransportError";
  }
}

export class TelegramRecipientUnreachableError extends MemoryReviewOwnerAlertTransportError {
  readonly chatId: string;
  readonly reason: TelegramRecipientUnreachableReason;

  constructor(chatId: string, reason: TelegramRecipientUnreachableReason) {
    super(
      "failed",
      TELEGRAM_RECIPIENT_UNREACHABLE_CODE,
      "Telegram не доставляет сообщения в этот чат: бот заблокирован, удалён из группы или чат недоступен",
    );
    this.chatId = chatId;
    this.reason = reason;
    this.name = "TelegramRecipientUnreachableError";
  }
}

interface MemoryReviewOwnerAlertTransportDependencies {
  botToken: string;
  fetch: typeof fetch;
  timeoutMilliseconds: number;
  /** The reason a bot-started message must skip this chat; absent in tests that do not need it. */
  unreachableRecipient?: (chatId: string) => Promise<TelegramRecipientUnreachableReason | null>;
}

export interface MemoryReviewOwnerAlertTransport {
  deliver(input: { chatId: string; text: string }): Promise<void>;
}

export function createMemoryReviewOwnerAlertTransport(
  dependencies: MemoryReviewOwnerAlertTransportDependencies,
): MemoryReviewOwnerAlertTransport {
  if (!dependencies.botToken) throw new AppError(
    "AGENT_TELEGRAM_CONFIG_MISSING",
    "Не задан токен Telegram для уведомления владельца",
  );
  if (!Number.isSafeInteger(dependencies.timeoutMilliseconds) ||
      dependencies.timeoutMilliseconds <= 0) throw new AppError(
    "AGENT_MEMORY_REVIEW_OWNER_ALERT_TIMEOUT_INVALID",
    "Тайм-аут уведомления владельца должен быть положительным целым числом",
  );

  const boundedFetch = withRequestTimeout(dependencies.fetch, dependencies.timeoutMilliseconds);
  return {
    async deliver(input): Promise<void> {
      let known: TelegramRecipientUnreachableReason | null;
      try {
        known = await dependencies.unreachableRecipient?.(input.chatId) ?? null;
      } catch {
        // Nothing reached Telegram, so this is a definite failure: a dispatcher may try again.
        throw new MemoryReviewOwnerAlertTransportError(
          "failed",
          "AGENT_TELEGRAM_REACHABILITY_UNAVAILABLE",
          "Не удалось проверить, доступен ли чат; сообщение не отправлено",
        );
      }
      if (known !== null) throw new TelegramRecipientUnreachableError(input.chatId, known);
      const response = await callTelegramApi({
        body: { chat_id: input.chatId, text: input.text },
        botToken: dependencies.botToken,
        fetch: boundedFetch,
        method: "sendMessage",
      });
      if (!response.ok) {
        const reason = classifyTelegramRecipientFailure(response.status, response.body);
        if (reason !== null) throw new TelegramRecipientUnreachableError(input.chatId, reason);
        throw new MemoryReviewOwnerAlertTransportError(
          "failed",
          "AGENT_MEMORY_REVIEW_OWNER_ALERT_TELEGRAM_REJECTED",
          "Telegram отклонил уведомление владельца о сбое проверки памяти",
        );
      }
    },
  };
}

function productionTransport(): MemoryReviewOwnerAlertTransport {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new AppError(
    "AGENT_TELEGRAM_CONFIG_MISSING",
    "Не задан токен Telegram для уведомления владельца",
  );
  return createMemoryReviewOwnerAlertTransport({
    botToken,
    fetch,
    timeoutMilliseconds: TELEGRAM_API_REQUEST_TIMEOUT_MS,
    unreachableRecipient: (chatId) => unreachableTelegramRecipient(chatId, "owner_notice"),
  });
}

// Runtime secrets stay lazy so Eve discovery and build remain deterministic.
export const memoryReviewOwnerAlertTransport: MemoryReviewOwnerAlertTransport = {
  deliver: (input) => productionTransport().deliver(input),
};
