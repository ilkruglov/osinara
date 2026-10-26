/**
 * Production order watches: the person's own browser, their private chat, their notification history.
 *
 * Exports:
 * - `dispatchDueOrderWatches`: the minute tick used by the Eve schedule.
 * - `observeOrder`, `sendOrderWatchMessage`: the browser look and the Telegram message of one watch.
 *
 * Key constructs:
 * - The order is read through the same clients the tools use, in the sandbox that holds the person's
 *   Yandex login (`yandex_taxi` status, `yandex_lavka` tracked orders); nothing is ordered or changed.
 * - A look runs under a hold on the person's browser, taken only while their chat is idle; a turn's
 *   browser commands wait for it (`browser-hold.ts`). A chat that is not idle gives `busy`.
 * - When a look had to move the tab to the service's page, the saved look of that sandbox is dropped:
 *   the model's numbers described a page that is no longer shown.
 * - A message goes only to a chat not already known to be gone, and lands in the person's
 *   notification history, so the next turn knows what Mia said on her own.
 */
import { randomUUID } from "node:crypto";

import { callTelegramApi } from "eve/channels/telegram";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../../config.js";
import { AppError } from "../app-error.js";
import type { BrowserDriver } from "../browser/browser-driver.js";
import { browserHoldRepository } from "../browser/browser-hold.js";
import { lookRepository } from "../browser/look-repository.js";
import { productionBrowserDriver } from "../browser/production-browser-driver.js";
import { createLavkaClient } from "../lavka/lavka-client.js";
import { TelegramRecipientUnreachableError } from "../memory-review/memory-review-owner-alert-transport.js";
import { proactiveDeliveryRepository, type ProactiveDeliveryReceipt } from "../proactive-deliveries/proactive-delivery-repository.js";
import { withRequestTimeout } from "../request-signal.js";
import { unreachableTelegramRecipient } from "../telegram-reachability/reachability-guard.js";
import { classifyTelegramRecipientFailure } from "../telegram-reachability/recipient-failure.js";
import { createYandexTaxiClient } from "../yandex-taxi/yandex-taxi-client.js";
import { ORDER_WATCH_BROWSER_HOLD_MS, ORDER_WATCH_LOOK_DEADLINE_MS } from "./order-watch-config.js";
import { createOrderWatchDispatcher, OrderWatchDeliveryRefusedError, type OrderObservation } from "./order-watch-dispatcher.js";
import { orderWatchRepository, type ClaimedOrderWatch } from "./order-watch-repository.js";

export async function observeOrder(watch: ClaimedOrderWatch): Promise<OrderObservation | "busy"> {
  const hold = { holder: randomUUID(), sandboxSessionId: watch.sandboxSessionId };
  if (!await browserHoldRepository.tryHold({ ...hold, idleChatId: watch.telegramChatId, ttlMs: ORDER_WATCH_BROWSER_HOLD_MS })) return "busy";
  try {
    // The whole look ends well before the hold does: a command already running when the deadline
    // fires finishes within its own 50 s bound, inside the hold.
    const browser = productionBrowserDriver({ background: { holder: hold.holder }, sandboxSessionId: watch.sandboxSessionId, signal: AbortSignal.timeout(ORDER_WATCH_LOOK_DEADLINE_MS) });
    return await lookAt(watch, browser, () => browserHoldRepository.holdsStill(hold));
  } finally {
    await browserHoldRepository.release(hold).catch((error: unknown) => {
      console.error(JSON.stringify({ code: "AGENT_ORDER_WATCH_HOLD_RELEASE_FAILED", error: error instanceof Error ? error.name : "unknown", watchId: watch.id }));
    });
  }
}

async function lookAt(watch: ClaimedOrderWatch, browser: BrowserDriver, stillHeld: () => Promise<boolean>): Promise<OrderObservation> {
  let moved = false;
  const driver: BrowserDriver = { ...browser, open: async (url) => { moved = true; await browser.open(url); } };
  try {
    if (watch.service === "yandex_taxi") {
      const { order } = await createYandexTaxiClient({ driver }).status(watch.orderId);
      if (order === null) throw new AppError("AGENT_YANDEX_TAXI_ORDER_NOT_FOUND", "Яндекс Go не нашёл такой заказ");
      return {
        service: "yandex_taxi",
        taxi: { car: order.car, driver: order.driver, finalCost: order.finalCost, minutesLeft: order.minutesLeft, plates: order.plates, status: order.status },
      };
    }
    const tracked = (await createLavkaClient({ driver }).trackedOrders()).find((order) => order.orderId === watch.orderId);
    return { lavka: tracked ? { status: tracked.status, subtitle: tracked.subtitle, title: tracked.title } : null, service: "yandex_lavka" };
  } finally {
    // Only while the browser is still the check's: after its hold, a turn's own new look is there.
    if (moved && await stillHeld().catch(() => false)) {
      await lookRepository.resetSandbox(watch.sandboxSessionId).catch((error: unknown) => {
        console.error(JSON.stringify({ code: "AGENT_ORDER_WATCH_LOOK_RESET_FAILED", error: error instanceof Error ? error.name : "unknown", watchId: watch.id }));
      });
    }
  }
}

export async function sendOrderWatchMessage(watch: ClaimedOrderWatch, text: string): Promise<ProactiveDeliveryReceipt> {
  const gone = await unreachableTelegramRecipient(watch.telegramChatId, "order_watch");
  if (gone !== null) throw new TelegramRecipientUnreachableError(watch.telegramChatId, gone);
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new AppError("AGENT_TELEGRAM_CONFIG_MISSING", "Не задан токен Telegram для сообщений о заказах");
  const response = await callTelegramApi({
    body: { chat_id: watch.telegramChatId, text },
    botToken,
    fetch: withRequestTimeout(fetch, TELEGRAM_API_REQUEST_TIMEOUT_MS),
    method: "sendMessage",
  });
  if (!response.ok) {
    const reason = classifyTelegramRecipientFailure(response.status, response.body);
    if (reason !== null) throw new TelegramRecipientUnreachableError(watch.telegramChatId, reason);
    throw new OrderWatchDeliveryRefusedError(response.status);
  }
  const sentId = (response.body as { result?: { message_id?: unknown } } | null)?.result?.message_id;
  const messageId = typeof sentId === "number" || typeof sentId === "string" ? String(sentId) : "";
  if (!/^[1-9]\d*$/u.test(messageId)) {
    throw new AppError("AGENT_ORDER_WATCH_DELIVERY_AMBIGUOUS", "Telegram принял сообщение о заказе, но не подтвердил его идентификатор");
  }
  return { messageId, text };
}

export const dispatchDueOrderWatches = createOrderWatchDispatcher({
  isMember: (watch) => orderWatchRepository.isMember(watch),
  observe: observeOrder,
  record: (watch, receipt, deliveredAt) => proactiveDeliveryRepository.record({
    content: receipt.text,
    deliveredAt,
    familyId: watch.familyId,
    groupId: null,
    messageThreadId: null,
    ownerUserId: watch.userId,
    scheduledFor: deliveredAt,
    scope: "personal",
    sourceId: watch.id,
    sourceKind: "order_watch",
    telegramChatId: watch.telegramChatId,
    telegramMessageId: receipt.messageId,
    title: watch.service === "yandex_taxi" ? "Такси" : "Лавка",
  }),
  repository: orderWatchRepository,
  send: sendOrderWatchMessage,
});
