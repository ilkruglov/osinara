/**
 * Every failed Bot API send marks its chat when Telegram says the chat itself is gone.
 *
 * Exports:
 * - `TelegramDeliveryFailure`: one failed call as Eve's Bot API client reports it.
 * - `recordTelegramDeliveryFailure`: classifies the failure and marks the chat; returns the reason.
 * - `installTelegramDeliveryFailureObserver`: registers the recorder where Eve's Bot API client looks for it.
 *
 * Key construct:
 * - Every Bot API call of the process, Eve's channel deliveries included, goes through
 *   `callTelegramApi` of the vendored Eve (`vendor/eve/.../channels/telegram/api.js`); after the final
 *   answer of a failed call it hands the failure to `reportTelegramDeliveryFailure` of our runtime
 *   module (`scripts/eve-runtime/telegram-send-pacing.ts`), which calls the function registered on
 *   `globalThis` under `osinara.telegramDeliveryFailureObserver`. Eve cannot import application
 *   modules, so the registration is the shared contract. Marking there covers scheduled runs,
 *   reminders and turn replies alike, without each transport classifying on its own. Two senders
 *   that call `fetch` directly (memory export, workspace files) are answers to a person and stay
 *   outside: a missed mark there costs nothing, the next bot-started send marks the chat.
 * - The report names when the failed attempt started. A message, an unblock or a return to the group
 *   received after that moment is newer than Telegram's answer, so the repository leaves the chat
 *   reachable and the stale answer is only logged.
 */
import {
  classifyTelegramRecipientFailure,
  TELEGRAM_RECIPIENT_UNREACHABLE_CODE,
  type TelegramRecipientUnreachableReason,
  telegramProviderDescription,
} from "./recipient-failure.js";
import {
  type TelegramReachabilityRepository,
  telegramReachabilityRepository,
} from "./reachability-repository.js";

export interface TelegramDeliveryFailure {
  readonly body: unknown;
  readonly chatId: string;
  readonly method: string;
  /** Epoch milliseconds when the failed attempt was handed to fetch. */
  readonly startedAt: number;
  readonly status: number;
}

const OBSERVER_KEY = Symbol.for("osinara.telegramDeliveryFailureObserver");

export async function recordTelegramDeliveryFailure(
  failure: TelegramDeliveryFailure,
  repository: Pick<TelegramReachabilityRepository, "markUndeliverable"> = telegramReachabilityRepository,
): Promise<TelegramRecipientUnreachableReason | null> {
  const reason = classifyTelegramRecipientFailure(failure.status, failure.body);
  if (reason === null) return null;
  const marked = await repository.markUndeliverable(failure.chatId, reason, new Date(failure.startedAt));
  console.warn(JSON.stringify({
    chatId: failure.chatId,
    code: marked ? TELEGRAM_RECIPIENT_UNREACHABLE_CODE : "AGENT_TELEGRAM_RECIPIENT_UNREACHABLE_STALE",
    method: failure.method,
    providerDescription: telegramProviderDescription(failure.body),
    providerStatus: failure.status,
    reason,
  }));
  return reason;
}

export function installTelegramDeliveryFailureObserver(): void {
  (globalThis as { [key: symbol]: unknown })[OBSERVER_KEY] =
    (failure: TelegramDeliveryFailure) => recordTelegramDeliveryFailure(failure);
}
