/**
 * The price of a ride as Yandex Go computes it for the person's account.
 *
 * Exports:
 * - `quoteYandexTaxiRide`: zone → tariffs → payment → routestats, shared by estimate and order, so
 *   an order is checked against exactly the computation the person saw.
 * - `YandexTaxiQuote`, `YandexTaxiTariffQuote`, `Finalized`: the shapes involved.
 * - `yandexTaxiCoordinates`, `yandexTaxiAuthHeaders`: wire helpers shared by the client modules.
 *
 * Key constructs:
 * - The zone comes from a reverse lookup (`finalsuggest` pin_drop) of the pickup point, so a saved
 *   place and a typed address are priced the same way.
 * - Like the site, tariffs hidden by routestats or absent from the zone are not offered; names come
 *   from zoneinfo, prices and pickup times from routestats.
 */
import { AppError } from "../app-error.js";
import { yandexTaxiPriceValue, type YandexTaxiPoint, type YandexTaxiPointFields } from "./yandex-taxi-model.js";
import {
  resolveYandexTaxiPayment,
  routeStatsPayment,
  yandexTaxiPaymentOptions,
  type YandexTaxiPayment,
  type YandexTaxiPaymentMethods,
  type YandexTaxiPaymentType,
} from "./yandex-taxi-payment.js";
import { yandexTaxiErrors, type YandexTaxiSession, type YandexTaxiTransport } from "./yandex-taxi-transport.js";

export interface YandexTaxiTariffQuote {
  available: boolean;
  fixedPrice: boolean;
  /** Exact price, or null when the site gave none or a range. */
  price: number | null;
  tariff: string;
  tariffName: string;
  waitingMinutes: number | null;
}

export interface YandexTaxiQuote {
  currency: string;
  /** Opaque id of this computation; orderdraft needs it, the model never sees it. */
  offer: string;
  payment: YandexTaxiPayment;
  paymentOptions: YandexTaxiPayment[];
  tariffs: YandexTaxiTariffQuote[];
}

export interface Finalized { available: boolean; entrance: string; point: YandexTaxiPointFields; unavailableReason: string; zone: string; }
interface RouteStats { currencySign: string; currencyText: string; levels: Array<{ class: string; fixed: boolean; hidden: boolean; price: string; unavailable: boolean; waitingSeconds: number | null }>; offer: string; }
interface ZoneInfo { currency: string; tariffs: Array<{ class: string; id: string; name: string }>; }

export const yandexTaxiCoordinates = (point: { lat: number; lon: number }): [number, number] => [point.lon, point.lat];
export const yandexTaxiAuthHeaders = (session: YandexTaxiSession) => ({ phoneId: session.phoneId, userId: session.userId });

export async function quoteYandexTaxiRide(
  transport: YandexTaxiTransport,
  session: YandexTaxiSession,
  input: { from: YandexTaxiPoint; payment?: { id?: string | undefined; type: YandexTaxiPaymentType } | undefined; to: YandexTaxiPoint },
): Promise<YandexTaxiQuote> {
  const at = yandexTaxiCoordinates(input.from);
  const pinned = await transport.ok<Finalized>({
    body: { action: "pin_drop", position: at, state: { accuracy: 0, fields: [], location: at, selected_class: "" }, sticky: false, type: "a" },
    endpoint: "finalSuggest", project: "finalize", userId: session.userId,
  });
  if (!pinned.available) {
    throw new AppError("AGENT_YANDEX_TAXI_ZONE_UNAVAILABLE", `Яндекс Go не возит из этой точки${pinned.unavailableReason ? `: ${pinned.unavailableReason}` : ""}`);
  }
  if (!pinned.zone) throw yandexTaxiErrors.responseInvalid("finalSuggest", "nearest_zone");
  const zone = await transport.ok<ZoneInfo>({
    body: { id: session.userId, options: true, size_hint: 400, skin_version: 7, supported: ["eula_actions", "childchair_v2"], supports_hideable_tariffs: true, zone_name: pinned.zone },
    endpoint: "zoneInfo", project: "zoneinfo", userId: session.userId,
  });
  const methods = await transport.ok<YandexTaxiPaymentMethods>({ body: { id: session.userId, location: at }, endpoint: "paymentMethods", project: "payments", userId: session.userId });
  const payment = resolveYandexTaxiPayment(methods, input.payment);
  const stats = await transport.ok<RouteStats>({
    body: {
      extended_description: true, format_currency: true, id: session.userId, is_lightweight: false, payment: routeStatsPayment(payment), requirements: { coupon: "" },
      route: [at, yandexTaxiCoordinates(input.to)], selected_class: "", summary_version: 2, supported_markup: "tml-0.1", supports_paid_options: true,
      tariff_requirements: zone.tariffs.map((tariff) => ({ class: tariff.id, requirements: { coupon: "" } })), use_toll_roads: false,
    },
    endpoint: "routeStats", project: "routestats", ...yandexTaxiAuthHeaders(session),
  }, () => new AppError("AGENT_YANDEX_TAXI_NO_TARIFFS", "Яндекс Go не нашёл тарифов для этого маршрута"));
  const currency = stats.currencySign || stats.currencyText || zone.currency;
  if (!currency) throw yandexTaxiErrors.responseInvalid("routeStats", "currency");
  const tariffs = zone.tariffs.flatMap((tariff): YandexTaxiTariffQuote[] => {
    const level = stats.levels.find((item) => item.class === tariff.class);
    if (!level || level.hidden) return [];
    const price = yandexTaxiPriceValue(level.price);
    return [{
      available: !level.unavailable && price !== null,
      fixedPrice: level.fixed,
      price,
      tariff: tariff.class,
      tariffName: tariff.name || tariff.class,
      waitingMinutes: level.waitingSeconds === null ? null : Math.max(1, Math.ceil(level.waitingSeconds / 60)),
    }];
  });
  return { currency, offer: stats.offer, payment, paymentOptions: yandexTaxiPaymentOptions(methods), tariffs };
}
