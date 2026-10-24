/**
 * Yandex Go through the person's own browser tab.
 *
 * Exports:
 * - `createYandexTaxiClient`: auth, places, suggest, estimate and status here, `placeOrder` and
 *   `cancel` from `yandex-taxi-order.ts`; every step is one `agent-browser eval` of the page script.
 * - `YandexTaxiClient`: its type.
 *
 * Key constructs:
 * - Every point the client returns carries its `key`; estimate and order refuse a point that does
 *   not match it (`requireYandexTaxiPoint`).
 * - suggest finalizes one candidate (the best one, or `pick`) into a point; the others are listed by
 *   title so the person can choose, and the opaque suggest log never reaches the model.
 * - Not a published API: a missing required field is `AGENT_YANDEX_TAXI_RESPONSE_INVALID`.
 */
import { randomUUID } from "node:crypto";

import { AppError } from "../app-error.js";
import {
  activeYandexTaxiOrders,
  requireYandexTaxiPoint,
  withYandexTaxiPointKey,
  yandexTaxiCancelState,
  yandexTaxiStatusLabel,
  type YandexTaxiPoint,
  type YandexTaxiPointFields,
} from "./yandex-taxi-model.js";
import type { YandexTaxiPaymentType } from "./yandex-taxi-payment.js";
import { cancelYandexTaxiOrder, placeYandexTaxiOrder, type YandexTaxiOrderView } from "./yandex-taxi-order.js";
import { quoteYandexTaxiRide, yandexTaxiAuthHeaders, yandexTaxiCoordinates, type Finalized } from "./yandex-taxi-quote.js";
import { createYandexTaxiTransport, yandexTaxiErrors, type YandexTaxiDriver } from "./yandex-taxi-transport.js";

const CLIENT_ID = "turboapp-taxi";

export function createYandexTaxiClient(deps: { driver: YandexTaxiDriver; sleep?: (ms: number) => Promise<void> }) {
  const transport = createYandexTaxiTransport(deps.driver);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    async auth() {
      const launched = await transport.launch();
      if (launched.kind === "login_required") return { activeOrders: [], state: "login_required", hint: "Войти в Яндекс: browser_open https://passport.yandex.ru/auth, номер телефона и код из СМС" };
      if (launched.kind === "blocked" || launched.session.blocked) return { activeOrders: [], state: "blocked" };
      const { session } = launched;
      if (!session.authorized) return { activeOrders: [], state: "phone_unconfirmed", hint: "Вход есть, но Яндекс Go не считает телефон подтверждённым: войдите заново через https://passport.yandex.ru/auth и подтвердите номер" };
      return { activeOrders: activeYandexTaxiOrders(session.orders), debt: session.debt, state: "ready" };
    },

    async places() {
      const session = await transport.session();
      const places = await transport.ok<Array<{ name: string; point: YandexTaxiPointFields }>>({ body: { id: session.userId }, endpoint: "userPlaces", project: "places", userId: session.userId });
      return { places: places.map((place) => ({ name: place.name, point: withYandexTaxiPointKey(place.point) })) };
    },

    async suggest(input: { near?: { lat: number; lon: number } | undefined; pick: number; query: string; type: "a" | "b" }) {
      const session = await transport.session();
      const location = input.near ? { location: yandexTaxiCoordinates(input.near) } : {};
      const results = await transport.ok<Array<{ log: unknown; position: [number, number] | null; subtitle: string; title: string }>>({
        body: { action: "user_input", client_id: CLIENT_ID, part: input.query, state: { accuracy: 0, selected_class: "", ...location }, suggest_serpid: randomUUID(), type: input.type },
        endpoint: "suggest", project: "suggest", userId: session.userId,
      });
      const chosen = results[input.pick];
      if (!chosen) throw new AppError("AGENT_YANDEX_TAXI_ADDRESS_NOT_FOUND", `Яндекс Go не нашёл адрес «${input.query.slice(0, 100)}»${results.length > 0 ? ` под номером ${input.pick}` : ""}. Уточните адрес (город, дом)`);
      const position = chosen.position ? { position: chosen.position } : {};
      const state = { accuracy: 0, fields: [], selected_class: "", ...(input.near ? location : chosen.position ? { location: chosen.position } : {}) };
      const finalized = await transport.ok<Finalized>({
        body: { action: "finalize", prev_log: chosen.log, state, sticky: false, type: input.type, ...position },
        endpoint: "finalSuggest", project: "finalize", userId: session.userId,
      });
      return {
        ...(finalized.available ? {} : { unavailable: finalized.unavailableReason || "Яндекс Go не возит из этой точки" }),
        entrance: finalized.entrance || null,
        others: results.map((item, index) => ({ pick: index, subtitle: item.subtitle, title: item.title })).filter((item) => item.pick !== input.pick),
        point: withYandexTaxiPointKey(finalized.point),
      };
    },

    async estimate(input: { from: YandexTaxiPoint; payment?: { id?: string | undefined; type: YandexTaxiPaymentType } | undefined; to: YandexTaxiPoint }) {
      const from = requireYandexTaxiPoint(input.from, "from");
      const to = requireYandexTaxiPoint(input.to, "to");
      const session = await transport.session();
      const quote = await quoteYandexTaxiRide(transport, session, { from, payment: input.payment, to });
      return { ...quote, from, to };
    },

    async status(orderId?: string) {
      const session = await transport.session();
      const active = activeYandexTaxiOrders(session.orders);
      const id = orderId ?? active[0]?.orderId;
      if (!id) return { activeOrders: active, order: null };
      const order = await transport.ok<YandexTaxiOrderView>({
        body: { format_currency: true, id: session.userId, orderid: id, show_text: true },
        endpoint: "taxiOnTheWay", project: "order", ...yandexTaxiAuthHeaders(session),
      }, yandexTaxiErrors.orderNotFound);
      const cancelState = order.cancelDisabled ? "disabled" : yandexTaxiCancelState(order.cancelState);
      return {
        activeOrders: active,
        order: {
          cancelMessage: order.cancelMessage || null, cancelState, car: order.car || null, driver: order.driverName || null, finalCost: order.finalCost || null,
          minutesLeft: order.timeLeftSeconds === null ? null : Math.max(0, Math.ceil(order.timeLeftSeconds / 60)), orderId: id, plates: order.plates || null,
          rating: order.rating || null, status: order.status, statusText: yandexTaxiStatusLabel(order.status), tariff: order.tariffClass || null,
        },
      };
    },

    placeOrder: (request: Parameters<typeof placeYandexTaxiOrder>[1]) => placeYandexTaxiOrder(transport, request, sleep),
    cancel: (request: Parameters<typeof cancelYandexTaxiOrder>[1]) => cancelYandexTaxiOrder(transport, request),
  };
}

export type YandexTaxiClient = ReturnType<typeof createYandexTaxiClient>;
