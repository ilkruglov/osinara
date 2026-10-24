/**
 * How a Yandex Go ride is paid: the methods of the account and the one this ride uses.
 *
 * Exports:
 * - `YandexTaxiPayment`, `YandexTaxiPaymentMethods`: a chosen method and the account's methods.
 * - `resolveYandexTaxiPayment`: the explicit choice, else the account's last used method.
 * - `yandexTaxiPaymentOptions`: what the person can choose from, with readable labels.
 * - `routeStatsPayment`, `orderDraftPayment`: the wire forms (they differ for the Yandex card).
 *
 * Key constructs:
 * - Never a card the person did not pick: without an explicit choice and without a usable
 *   `last_payment_method` the answer is `AGENT_YANDEX_TAXI_PAYMENT_MISSING` (the Lavka review of
 *   28 September 2026 removed "the first card that comes along" there too).
 * - Only cash, a bank card and the Yandex card are supported; corporate accounts and others are
 *   not offered and a last method of such a type counts as no method.
 */
import { AppError } from "../app-error.js";

export type YandexTaxiPaymentType = "card" | "cash" | "yandex_card";

export interface YandexTaxiPayment { id: string; label: string; type: YandexTaxiPaymentType; }

export interface YandexTaxiPaymentMethods {
  cards: Array<{ id: string; last4: string; system: string }>;
  last: { id: string; type: string } | null;
  /** Cards bound but waiting for verification in the app; they cannot pay. */
  unverifiedCardIds?: string[];
  yandexCards: Array<{ id: string }>;
}

const CASH: YandexTaxiPayment = { id: "cash", label: "наличные", type: "cash" };

function cardPayment(card: YandexTaxiPaymentMethods["cards"][number]): YandexTaxiPayment {
  const label = ["карта", card.system, card.last4 ? `••${card.last4}` : ""].filter(Boolean).join(" ");
  return { id: card.id, label, type: "card" };
}

const yandexCardPayment = (id: string): YandexTaxiPayment => ({ id, label: "Яндекс Карта", type: "yandex_card" });

export function yandexTaxiPaymentOptions(methods: YandexTaxiPaymentMethods): YandexTaxiPayment[] {
  return [CASH, ...methods.cards.map(cardPayment), ...methods.yandexCards.map((card) => yandexCardPayment(card.id))];
}

const missing = (detail: string): AppError =>
  new AppError("AGENT_YANDEX_TAXI_PAYMENT_MISSING", `${detail}. Спросите человека, как платить: наличные, карта или Яндекс Карта (paymentOptions из estimate)`);

function find(methods: YandexTaxiPaymentMethods, type: string, id: string): YandexTaxiPayment | null {
  if (type === "cash") return CASH;
  if (type === "card") {
    const card = methods.cards.find((item) => item.id === id);
    if (card) return cardPayment(card);
  }
  // The site reports a Yandex card as a card in some places; its id says which one it is.
  if (type === "yandex_card" || type === "card") {
    const card = methods.yandexCards.find((item) => item.id === id);
    if (card) return yandexCardPayment(card.id);
  }
  return null;
}

export function resolveYandexTaxiPayment(methods: YandexTaxiPaymentMethods, chosen?: { id?: string | undefined; type: YandexTaxiPaymentType }): YandexTaxiPayment {
  if (chosen) {
    const found = find(methods, chosen.type, chosen.id ?? "");
    if (!found) throw missing("Выбранного способа оплаты нет среди доступных в Яндекс Go");
    return found;
  }
  if (!methods.last) throw missing("В Яндекс Go не выбран способ оплаты");
  const found = find(methods, methods.last.type, methods.last.id);
  if (!found && methods.unverifiedCardIds?.includes(methods.last.id)) {
    throw missing("Карта, которой платили в Яндекс Go последний раз, ждёт подтверждения в приложении Яндекс Go и платить пока не может");
  }
  if (!found) throw missing("Последний способ оплаты в Яндекс Go недоступен или не поддерживается");
  return found;
}

export function routeStatsPayment(payment: YandexTaxiPayment): { payment_method_id?: string; type: string } {
  if (payment.type === "cash") return { type: "cash" };
  // routestats prices a Yandex card as a card with the card's id (site module 22544 and 78488).
  return { payment_method_id: payment.id, type: "card" };
}

export function orderDraftPayment(payment: YandexTaxiPayment): { payment_method_id: string; type: string } {
  return { payment_method_id: payment.id, type: payment.type };
}
