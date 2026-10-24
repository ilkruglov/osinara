/**
 * Yandex Go taxi in the person's private chat: login state, addresses, prices, the order and its status.
 *
 * Exports:
 * - `yandex_taxi`: auth, places, suggest, estimate, order, status, cancel.
 *
 * Key constructs:
 * - Everything runs in the person's own logged-in taxi.yandex.ru tab in their sandbox, so each family
 *   member rides on their own Yandex account and nobody's session is stored by the bot.
 * - `order` and `cancel` are gated by a Telegram confirmation built from the same input; execution
 *   re-prices the ride (or re-reads the cancellation terms) and refuses any drift from what was shown.
 * - `order` and `cancel` run under `runYandexTaxiOperation` keyed by `session:callId`: a step Eve
 *   replays after a crash returns the stored result or an ambiguity code, never a second car.
 */
import { defineTool } from "eve/tools";

import { AppError } from "../app-error.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { requireToolApprovalEvidence } from "../require-tool-approval-evidence.js";
import { YANDEX_TAXI_APPROVAL_ACTIONS, yandexTaxiInput } from "../yandex-taxi/yandex-taxi-input.js";
import {
  requireYandexTaxiFamilyMember,
  runYandexTaxiOperation,
  yandexTaxiOperationRepository,
  type YandexTaxiOperationAction,
} from "../yandex-taxi/yandex-taxi-operation.js";
import { yandexTaxiClientFor } from "../yandex-taxi/yandex-taxi-production.js";

export default defineTool({
  approval: ({ toolInput }) => {
    const action = (toolInput as { action?: unknown } | null)?.action;
    return typeof action === "string" && YANDEX_TAXI_APPROVAL_ACTIONS.has(action) ? "user-approval" : "not-applicable";
  },
  description: [
    "Такси Яндекс Go из аккаунта человека в его браузере. auth: есть ли вход и активный заказ. places: сохранённые адреса. suggest: адрес по тексту (query, type from|to, near рядом, pick из others). point из ответа передавай дальше без изменений.",
    "Сначала estimate (from, to, payment по желанию): тарифы, цены, подача, оплата. Покажи человеку тариф, цену и оплату; order только после его явного согласия, с from, to, payment, currency и tariff, tariffName, price, fixedPrice, waitingMinutes выбранного тарифа ровно из estimate (porch, comment по желанию); человек подтверждает кнопкой; заказ уйдёт, если цена при заказе не выше на 5 %. PRICE_CHANGED: новый estimate и новое согласие.",
    "При неясном исходе заказа никогда не заказывай повторно, смотри status. status (orderId или активный): машина, номер, водитель, через сколько, по просьбе. cancel: orderId, cancelState и cancelMessage из status, с подтверждением.",
    "Нет входа: browser_open https://passport.yandex.ru/auth и код из СМС.",
  ].join(" "),
  inputSchema: yandexTaxiInput,
  async execute(input, ctx) {
    const auth = requireMemoryAuthorization(ctx);
    if (auth.groupId !== null || auth.role === "external" || auth.userId === null) {
      throw new AppError("AGENT_YANDEX_TAXI_ACCESS_DENIED", "Такси заказывают только члены семьи в личном чате");
    }
    const { familyId, userId } = auth;
    // The turn's attributes may predate a removal from the family; the person's browser and Yandex
    // account are reached only by a current member (Codex review, 24 October 2026).
    await requireYandexTaxiFamilyMember(familyId, userId);
    const client = yandexTaxiClientFor(ctx);
    // A confirmed order or cancellation is bound to its call id, as its approval is.
    const once = async <T>(action: YandexTaxiOperationAction, run: () => Promise<T>) => {
      const done = await runYandexTaxiOperation(yandexTaxiOperationRepository, { action, familyId, key: `${ctx.session.id}:${ctx.callId}`, request: input, userId }, async () => {
        await requireToolApprovalEvidence(ctx, "yandex_taxi", input);
        return await run();
      });
      return done.result;
    };
    switch (input.action) {
      case "auth": return await client.auth();
      case "places": return await client.places();
      case "suggest": return await client.suggest({ near: input.near, pick: input.pick ?? 0, query: input.query!, type: input.type === "from" ? "a" : "b" });
      case "estimate": {
        // The offer is re-issued on every pricing, so order prices the ride again; the model never needs it.
        const { offer: _offer, ...estimate } = await client.estimate({ from: input.from!, payment: input.payment, to: input.to! });
        return { ...estimate, note: "Для order: from, to, payment, currency отсюда и tariff, tariffName, price, fixedPrice, waitingMinutes выбранного тарифа" };
      }
      case "order": return await once("order", () => client.placeOrder({
        comment: input.comment, currency: input.currency!, fixedPrice: input.fixedPrice!, from: input.from!,
        payment: { id: input.payment!.id, label: input.payment!.label!, type: input.payment!.type }, porch: input.porch, price: input.price!,
        tariff: input.tariff!, tariffName: input.tariffName!, to: input.to!,
      }));
      case "status": return await client.status(input.orderId);
      case "cancel": return await once("cancel", () => client.cancel({ cancelMessage: input.cancelMessage, cancelState: input.cancelState!, orderId: input.orderId! }));
    }
  },
});
