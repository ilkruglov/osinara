/**
 * Shapes the Yandex Go tool shows and takes back: route points, prices, order statuses.
 *
 * Exports:
 * - `YandexTaxiPoint`, `yandexTaxiPointKey`, `requireYandexTaxiPoint`: a route point and the
 *   fingerprint that binds its text to its coordinates.
 * - `yandexTaxiPriceValue`: the one number in a routestats price template, or null.
 * - `yandexTaxiMaxPrice`: the highest price an order confirmed at a given price may go through at.
 * - `activeYandexTaxiOrders`: launch orders that are still going on.
 * - `yandexTaxiStatusLabel`, `yandexTaxiCancelState`, `YANDEX_TAXI_CANCEL_LABELS`.
 *
 * Key constructs:
 * - The confirmation window shows a point's text while the order carries its coordinates. Every
 *   point the tool returns carries `key`, an HMAC over both with a server-side key: a point whose
 *   text was edited or whose coordinates were swapped no longer matches and is refused before
 *   anything is sent, and a point made up elsewhere (a prompt injection pairing a familiar address
 *   with other coordinates) cannot carry a valid key. A plain hash could be computed by anyone
 *   (security review, 24 October 2026).
 * - A price with more than one number in it ("от 300 до 400") has no exact value and cannot be
 *   confirmed as one.
 */
import { createHmac } from "node:crypto";

import { AppError } from "../app-error.js";
import { requireInvitationSigningSecret } from "../invitation-code.js";
import { YANDEX_TAXI_FINISHED_STATUSES, YANDEX_TAXI_PRICE_RISE_PERCENT } from "./yandex-taxi-config.js";

export interface YandexTaxiPoint {
  city: string;
  fullText: string;
  key: string;
  lat: number;
  lon: number;
  shortText: string;
  uri: string;
}

export type YandexTaxiPointFields = Omit<YandexTaxiPoint, "key">;

/**
 * The installation's signing secret (required in production), narrowed to this one purpose: the
 * derived key signs route points only, so a key never doubles as an invitation signature.
 */
function pointSigningKey(): Buffer {
  return createHmac("sha256", requireInvitationSigningSecret()).update("osinara/yandex-taxi-point/v1", "utf8").digest();
}

export function yandexTaxiPointKey(point: YandexTaxiPointFields): string {
  const fields = JSON.stringify([point.shortText, point.fullText, point.lon.toFixed(6), point.lat.toFixed(6), point.uri, point.city]);
  return createHmac("sha256", pointSigningKey()).update(fields, "utf8").digest("hex").slice(0, 16);
}

export function withYandexTaxiPointKey(point: YandexTaxiPointFields): YandexTaxiPoint {
  return { ...point, key: yandexTaxiPointKey(point) };
}

/** A point exactly as a tool result gave it; anything edited on the way is refused. */
export function requireYandexTaxiPoint(point: YandexTaxiPoint, role: "from" | "to"): YandexTaxiPoint {
  if (yandexTaxiPointKey(point) !== point.key) {
    throw new AppError(
      "AGENT_YANDEX_TAXI_POINT_REF_INVALID",
      `Точка ${role === "from" ? "откуда" : "куда"} изменена после places или suggest. Передайте объект point ровно из их ответа`,
    );
  }
  return point;
}

const PRICE_NUMBER = /\d[\d\s   ]*(?:[.,]\d+)?/gu;

export function yandexTaxiPriceValue(template: string): number | null {
  // Placeholders like $SIGN$$CURRENCY$ and markup tags carry no digits of the price.
  const cleaned = template.replace(/\$[A-Z_]+\$/gu, " ").replace(/<[^>]*>/gu, " ");
  const numbers = (cleaned.match(PRICE_NUMBER) ?? []).map((group) => group.replace(/[\s   ]/gu, "").replace(",", "."));
  if (numbers.length !== 1) return null;
  const value = Number(numbers[0]);
  return Number.isFinite(value) ? value : null;
}

/** The ceiling the confirmation window names and the order enforces; both derive it from the input. */
export function yandexTaxiMaxPrice(price: number): number {
  return Math.floor(price * (100 + YANDEX_TAXI_PRICE_RISE_PERCENT) / 100);
}

export interface YandexTaxiLaunchOrder { orderId: string; status: string; }

/**
 * Orders that block a new one. The site skips drafts and the finished statuses; an unknown status
 * counts as active, because refusing a second car is cheaper than ordering one.
 */
export function activeYandexTaxiOrders(orders: readonly YandexTaxiLaunchOrder[]): YandexTaxiLaunchOrder[] {
  return orders.filter((order) => order.status !== "draft" && !YANDEX_TAXI_FINISHED_STATUSES.has(order.status));
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  boarding: "посадка",
  calling: "водитель на месте и ждёт",
  cancelled: "заказ отменён",
  complete: "поездка завершена",
  draft: "черновик, заказ не отправлен",
  driving: "машина едет к вам",
  expired: "машину не нашли",
  failed: "заказ не выполнен",
  preexpired: "поиск машины заканчивается",
  scheduled: "предзаказ принят",
  scheduling: "оформляется предзаказ",
  search: "ищем машину",
  transporting: "в пути",
  waiting: "машина ждёт на месте",
};

export function yandexTaxiStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? `статус Яндекс Go «${status.slice(0, 40)}»`;
}

export type YandexTaxiCancelState = "disabled" | "free" | "minimal" | "paid" | "unknown";

export function yandexTaxiCancelState(value: string): YandexTaxiCancelState {
  return value === "free" || value === "minimal" || value === "paid" || value === "disabled" ? value : "unknown";
}

export const YANDEX_TAXI_CANCEL_LABELS: Readonly<Record<Exclude<YandexTaxiCancelState, "disabled">, string>> = {
  free: "бесплатно",
  minimal: "с минимальной платой",
  paid: "платно",
  unknown: "Яндекс Go не сообщил условия",
};
