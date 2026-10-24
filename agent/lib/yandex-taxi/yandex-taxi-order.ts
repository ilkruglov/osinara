/**
 * Ordering and cancelling a Yandex Go ride: the two calls that spend money.
 *
 * Exports:
 * - `placeYandexTaxiOrder`: re-checks the session and active orders, re-prices the ride, refuses any
 *   drift from what the person confirmed, then orderdraft → ordercommit.
 * - `cancelYandexTaxiOrder`: re-reads the order, refuses when the cancellation terms changed since the
 *   person confirmed them, then taxiontheway with `break: "user"`.
 * - `YandexTaxiOrderRequest`, `YandexTaxiOrderView`.
 *
 * Key constructs:
 * - Like the site, no new order while launch lists an active one (`AGENT_YANDEX_TAXI_ORDER_ACTIVE`).
 * - The ride is re-priced right before orderdraft, and the draft carries that fresh `offer`: routestats
 *   issues a new offer on every call and moves some prices within seconds (live run, 24 October
 *   2026), so a confirmed offer would never match. The fresh price may not exceed the ceiling the
 *   window named (`yandexTaxiMaxPrice`);
 *   the currency, fixed-price flag and tariff name must be the same, and the payment label the person
 *   saw must still name the same method; otherwise `AGENT_YANDEX_TAXI_PRICE_CHANGED` /
 *   `AGENT_YANDEX_TAXI_PAYMENT_CHANGED` before anything is sent. A different price within the ceiling
 *   the window named goes through and the result says so.
 * - orderdraft and ordercommit are never repeated after an unclear outcome (no answer, 5xx, an
 *   unreadable body, a timeout): that is `AGENT_YANDEX_TAXI_ORDER_AMBIGUOUS`, after one launch to see
 *   whether an order appeared. ordercommit is repeated only on 202, which is the site's protocol.
 *   A refusal the server explained (4xx, captcha, a tab that never sent) placed nothing, and so did
 *   any failure while re-pricing or re-reading: those are marked `yandexTaxiNothingSent`.
 */
import { AppError, isAppError } from "../app-error.js";
import { YANDEX_TAXI_COMMIT_RETRIES, YANDEX_TAXI_COMMIT_RETRY_MS, YANDEX_TAXI_FINISHED_STATUSES, type YandexTaxiEndpoint } from "./yandex-taxi-config.js";
import {
  activeYandexTaxiOrders,
  requireYandexTaxiPoint,
  yandexTaxiCancelState,
  yandexTaxiStatusLabel,
  type YandexTaxiLaunchOrder,
  yandexTaxiMaxPrice,
  type YandexTaxiPoint,
} from "./yandex-taxi-model.js";
import { orderDraftPayment, type YandexTaxiPaymentType } from "./yandex-taxi-payment.js";
import type { YandexTaxiPageResult } from "./yandex-taxi-page-script.js";
import { quoteYandexTaxiRide, yandexTaxiAuthHeaders, yandexTaxiCoordinates } from "./yandex-taxi-quote.js";
import { yandexTaxiErrors, yandexTaxiNothingSent, yandexTaxiSiteRefusal, yandexTaxiUnsettled, type YandexTaxiTransport } from "./yandex-taxi-transport.js";

export interface YandexTaxiOrderRequest {
  comment?: string | undefined;
  currency: string;
  fixedPrice: boolean;
  from: YandexTaxiPoint;
  payment: { id?: string | undefined; label: string; type: YandexTaxiPaymentType };
  porch?: string | undefined;
  price: number;
  tariff: string;
  tariffName: string;
  to: YandexTaxiPoint;
}

export interface YandexTaxiOrderView {
  cancelDisabled: boolean; cancelMessage: string; cancelState: string; car: string; driverName: string; finalCost: string;
  plates: string; rating: string; status: string; tariffClass: string; timeLeftSeconds: number | null;
}

/** Failures raised before the request left the tab: nothing reached Yandex Go. */
const NOT_SENT: ReadonlySet<string> = new Set(["AGENT_YANDEX_TAXI_CAPTCHA", "AGENT_YANDEX_TAXI_TAB_MOVED", "AGENT_YANDEX_TAXI_TAB_UNAVAILABLE"]);

const causeOf = (error: unknown): string => isAppError(error) ? error.code : "unknown";
const isSuccess = (result: YandexTaxiPageResult) => result.status >= 200 && result.status < 300 && result.status !== 202 && result.error === null && result.data !== null;

/** The named error of a request the server refused outright, or null when the outcome is unclear. */
function definitiveRefusal(endpoint: YandexTaxiEndpoint, result: YandexTaxiPageResult): AppError | null {
  // The CSRF token is fetched before the request; when it fails, the request was not accepted.
  if (result.error === "csrf_failed") return result.status === 401 || result.status === 403 ? yandexTaxiErrors.authRequired() : yandexTaxiErrors.unavailable(endpoint, `csrf_status_${result.status}`);
  if (result.status === 401) return yandexTaxiErrors.authRequired();
  if (result.status === 403) return yandexTaxiErrors.blocked();
  if (result.status === 429) return yandexTaxiErrors.rateLimited();
  if (result.status >= 400 && result.status < 500 && result.status !== 408) {
    if (result.code === "PRICE_CHANGED") {
      console.error(JSON.stringify({ code: "AGENT_YANDEX_TAXI_PRICE_CHANGED", endpoint, status: result.status }));
      return new AppError("AGENT_YANDEX_TAXI_PRICE_CHANGED", "Яндекс Go сообщил, что цена изменилась. Сделайте новый estimate, покажите человеку и подтвердите заново");
    }
    return yandexTaxiSiteRefusal(endpoint, result);
  }
  return null;
}

/**
 * A page call that came back saying its request never went out (a CSRF failure, a deadline before
 * the send): whatever it says, Yandex Go received nothing, and the operation ledger may free the call.
 */
function notSent(endpoint: YandexTaxiEndpoint, result: YandexTaxiPageResult): AppError {
  return yandexTaxiNothingSent(definitiveRefusal(endpoint, result) ?? yandexTaxiErrors.unavailable(endpoint, yandexTaxiUnsettled(result)));
}

async function orderAmbiguous(transport: YandexTaxiTransport, stage: "commit" | "draft", cause: string, orderId: string | null): Promise<AppError> {
  let active: YandexTaxiLaunchOrder[] | null = null;
  try {
    const launched = await transport.launch();
    if (launched.kind === "session") active = activeYandexTaxiOrders(launched.session.orders);
  } catch { active = null; }
  console.error(JSON.stringify({ activeOrders: active?.length ?? null, cause: cause.slice(0, 80), code: "AGENT_YANDEX_TAXI_ORDER_AMBIGUOUS", stage }));
  const number = orderId ? ` Номер заказа: ${orderId}.` : "";
  const message = active === null
    ? `Не удалось понять, принят ли заказ, и проверить это не вышло.${number} Не заказывайте снова: через минуту посмотрите status или приложение Яндекс Go`
    : active.length > 0
      ? `Не удалось понять ответ Яндекс Go, но у вас есть активный заказ ${active[0]!.orderId || "без номера"}. Посмотрите status; новый заказ не делайте`
      : `Не удалось понять, принят ли заказ; активного заказа Яндекс Go пока не показывает.${number} Не заказывайте снова сами: через минуту посмотрите status или приложение Яндекс Go`;
  return new AppError("AGENT_YANDEX_TAXI_ORDER_AMBIGUOUS", message);
}

const routePoint = (point: YandexTaxiPoint, type: "a" | "b", porch = "") => ({
  city: point.city, fullname: point.fullText, geopoint: yandexTaxiCoordinates(point), porchnumber: porch, short_text: point.shortText, type, uri: point.uri,
});

const money = (price: number | null, currency: string, fixed: boolean) => price === null ? "без точной цены" : `${fixed ? "" : "≈ "}${price} ${currency}`;

export async function placeYandexTaxiOrder(transport: YandexTaxiTransport, request: YandexTaxiOrderRequest, sleep: (ms: number) => Promise<void>) {
  // Everything up to orderdraft only reads; any failure there placed nothing.
  const prepared = await prepareOrder(transport, request).catch((error: unknown) => { throw yandexTaxiNothingSent(error); });
  return await submitOrder(transport, request, prepared, sleep);
}

async function prepareOrder(transport: YandexTaxiTransport, request: YandexTaxiOrderRequest) {
  const from = requireYandexTaxiPoint(request.from, "from");
  const to = requireYandexTaxiPoint(request.to, "to");
  const session = await transport.session();
  const active = activeYandexTaxiOrders(session.orders);
  if (active.length > 0) {
    throw new AppError("AGENT_YANDEX_TAXI_ORDER_ACTIVE", `У вас уже есть активный заказ такси${active[0]!.orderId ? ` (${active[0]!.orderId})` : ""}. Новый не создан: посмотрите status`);
  }
  const quote = await quoteYandexTaxiRide(transport, session, { from, payment: { id: request.payment.id, type: request.payment.type }, to });
  if (quote.payment.type !== request.payment.type || quote.payment.label !== request.payment.label) {
    throw new AppError("AGENT_YANDEX_TAXI_PAYMENT_CHANGED", `Способ оплаты сейчас «${quote.payment.label}», а подтверждали «${request.payment.label}». Сделайте новый estimate и подтвердите заново`);
  }
  const level = quote.tariffs.find((tariff) => tariff.tariff === request.tariff);
  if (!level || !level.available) {
    throw new AppError("AGENT_YANDEX_TAXI_TARIFF_UNAVAILABLE", `Тариф «${request.tariffName}» сейчас недоступен на этом маршруте. Сделайте новый estimate`);
  }
  // The window named this ceiling; any price up to it is what the person agreed to.
  const rose = level.price === null || level.price > yandexTaxiMaxPrice(request.price);
  if (rose || quote.currency !== request.currency || level.fixedPrice !== request.fixedPrice || level.tariffName !== request.tariffName) {
    console.error(JSON.stringify({ code: "AGENT_YANDEX_TAXI_PRICE_CHANGED", fixedChanged: level.fixedPrice !== request.fixedPrice, priceRose: rose }));
    throw new AppError(
      "AGENT_YANDEX_TAXI_PRICE_CHANGED",
      `Условия изменились после оценки: сейчас «${level.tariffName}» ${money(level.price, quote.currency, level.fixedPrice)}, подтверждали ${money(request.price, request.currency, request.fixedPrice)}. Сделайте новый estimate, покажите человеку и подтвердите заново`,
    );
  }
  return { from, price: level.price!, quote, session, to };
}

async function submitOrder(
  transport: YandexTaxiTransport,
  request: YandexTaxiOrderRequest,
  { from, price, quote, session, to }: Awaited<ReturnType<typeof prepareOrder>>,
  sleep: (ms: number) => Promise<void>,
) {
  const auth = yandexTaxiAuthHeaders(session);
  const draftBody = {
    class: [request.tariff], ...(request.comment ? { comment: request.comment } : {}), dont_sms: false, driverclientchat_enabled: true, id: session.userId,
    location: yandexTaxiCoordinates(from), offer: quote.offer, parks: [], payment: orderDraftPayment(quote.payment), requirements: { coupon: "" },
    route: [routePoint(from, "a", request.porch ?? ""), routePoint(to, "b")],
  };
  let draft: YandexTaxiPageResult;
  try {
    draft = await transport.call({ body: draftBody, endpoint: "orderDraft", project: "draft", ...auth });
  } catch (error) {
    if (isAppError(error) && NOT_SENT.has(error.code)) throw error;
    throw await orderAmbiguous(transport, "draft", causeOf(error), null);
  }
  if (draft.sent === false) throw notSent("orderDraft", draft);
  const draftRefused = definitiveRefusal("orderDraft", draft);
  if (draftRefused) throw draftRefused;
  if (!isSuccess(draft)) throw await orderAmbiguous(transport, "draft", draft.error ?? `status_${draft.status}`, null);
  const { orderId } = draft.data as { orderId: string };

  for (let attempt = 0; ; attempt += 1) {
    let commit: YandexTaxiPageResult;
    try {
      commit = await transport.call({ body: { id: session.userId, orderid: orderId }, endpoint: "orderCommit", project: "commit", ...auth });
    } catch (error) {
      // Before the first commit left the tab there is only a draft; after a 202 the order is in flight.
      if (attempt === 0 && isAppError(error) && NOT_SENT.has(error.code)) throw error;
      throw await orderAmbiguous(transport, "commit", causeOf(error), orderId);
    }
    if (commit.status === 202) {
      if (attempt < YANDEX_TAXI_COMMIT_RETRIES) { await sleep(YANDEX_TAXI_COMMIT_RETRY_MS); continue; }
      throw await orderAmbiguous(transport, "commit", "status_202", orderId);
    }
    if (attempt === 0) {
      // Only a draft exists until the first commit leaves the tab: no car is searched for.
      if (commit.sent === false) throw notSent("orderCommit", commit);
      const commitRefused = definitiveRefusal("orderCommit", commit);
      if (commitRefused) throw commitRefused;
    }
    if (!isSuccess(commit)) throw await orderAmbiguous(transport, "commit", commit.error ?? `status_${commit.status}`, orderId);
    const status = (commit.data as { status: string }).status;
    const moved = price !== request.price ? ` Цена при заказе ${money(price, quote.currency, request.fixedPrice)} (подтверждали ${money(request.price, request.currency, request.fixedPrice)}).` : "";
    return {
      currency: quote.currency,
      note: `Заказ принят.${moved} Как найдётся машина, статус покажет её, номер и время подачи (status)`,
      orderId,
      price,
      status: status || null,
      statusText: status ? yandexTaxiStatusLabel(status) : null,
    };
  }
}

const cancelUnavailable = (detail: string) => new AppError("AGENT_YANDEX_TAXI_CANCEL_UNAVAILABLE", `Отменить заказ нельзя: ${detail}`);

export async function cancelYandexTaxiOrder(
  transport: YandexTaxiTransport,
  request: { cancelMessage?: string | undefined; cancelState: "free" | "minimal" | "paid" | "unknown"; orderId: string },
) {
  // Re-reading the order only reads; any failure there cancelled nothing.
  const { auth, body } = await (async () => {
    const session = await transport.session();
    const headers = yandexTaxiAuthHeaders(session);
    const read = { format_currency: true, id: session.userId, orderid: request.orderId, show_text: true };
    const current = await transport.ok<YandexTaxiOrderView>({ body: read, endpoint: "taxiOnTheWay", project: "order", ...headers }, yandexTaxiErrors.orderNotFound);
    if (YANDEX_TAXI_FINISHED_STATUSES.has(current.status)) throw cancelUnavailable(yandexTaxiStatusLabel(current.status));
    const state = current.cancelDisabled ? "disabled" : yandexTaxiCancelState(current.cancelState);
    if (state === "disabled") throw cancelUnavailable("Яндекс Go сейчас не даёт отменить этот заказ, отмена только в приложении или через поддержку");
    // The person agreed to these terms; a free cancellation that turned paid needs a new agreement.
    if (state !== request.cancelState || (state !== "free" && current.cancelMessage !== (request.cancelMessage ?? ""))) {
      throw new AppError("AGENT_YANDEX_TAXI_CANCEL_CHANGED", "Условия отмены изменились после подтверждения. Посмотрите status, покажите человеку новые условия и подтвердите отмену заново");
    }
    return { auth: headers, body: read };
  })().catch((error: unknown) => { throw yandexTaxiNothingSent(error); });
  let result: YandexTaxiPageResult;
  try {
    result = await transport.call({ body: { ...body, break: "user" }, endpoint: "taxiOnTheWay", project: "cancel", ...auth });
  } catch (error) {
    if (isAppError(error) && NOT_SENT.has(error.code)) throw error;
    console.error(JSON.stringify({ cause: causeOf(error), code: "AGENT_YANDEX_TAXI_CANCEL_AMBIGUOUS" }));
    throw new AppError("AGENT_YANDEX_TAXI_CANCEL_AMBIGUOUS", "Не удалось понять, отменён ли заказ. Посмотрите status, прежде чем отменять снова");
  }
  if (result.sent === false) throw notSent("taxiOnTheWay", result);
  if (result.status === 404) throw yandexTaxiErrors.orderNotFound();
  const refused = definitiveRefusal("taxiOnTheWay", result);
  if (refused) throw refused;
  if (!isSuccess(result)) {
    console.error(JSON.stringify({ cause: result.error ?? `status_${result.status}`, code: "AGENT_YANDEX_TAXI_CANCEL_AMBIGUOUS" }));
    throw new AppError("AGENT_YANDEX_TAXI_CANCEL_AMBIGUOUS", "Не удалось понять, отменён ли заказ. Посмотрите status, прежде чем отменять снова");
  }
  const status = (result.data as { status: string }).status;
  return {
    cancelled: status === "cancelled",
    note: status === "cancelled" ? "Заказ отменён" : "Яндекс Go принял отмену; итоговый статус покажет status",
    orderId: request.orderId,
    status: status || null,
  };
}
