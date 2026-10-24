/**
 * Ordering and cancelling a Yandex Go ride over a fake browser tab.
 *
 * Constructs covered:
 * - No draft while launch lists an active order, or when the price rose past the ceiling the window
 *   named or the currency, fixed flag, tariff name or payment label drifted from what the person
 *   confirmed; another price within the ceiling goes through and is reported. The draft carries the fresh offer of the re-pricing, never a confirmed one.
 * - A confirmed ride is drafted once and committed; ordercommit is repeated only on 202, at the
 *   site's 5 s pace and at most 4 times.
 * - orderdraft and ordercommit are never repeated after an unclear outcome (5xx, no answer, an
 *   unreadable body, a browser timeout): that is ambiguous, and the error says what launch shows.
 * - A refusal the server explained (PRICE_CHANGED, another 4xx, a captcha) is named, not ambiguous.
 * - A failure while re-pricing, or a draft call that never started its request, is marked as having
 *   sent nothing, so the operation ledger frees the call; a started one that timed out is ambiguous.
 * - A cancellation re-reads the order, refuses changed terms and a finished order, and sends
 *   `break: "user"` once.
 */
import { describe, expect, it } from "vitest";

import { ModelFacingError } from "../model-facing-error.js";
import { createYandexTaxiClient } from "./yandex-taxi-client.js";
import { isYandexTaxiNothingSent } from "./yandex-taxi-transport.js";
import type { YandexTaxiOrderRequest } from "./yandex-taxi-order.js";
import { fakeTaxiTab, fromPoint, launchOk, PATHS, pricedRoute, routeStats, toPoint, type TaxiAnswers } from "./yandex-taxi.test-fixtures.js";

const confirmed: YandexTaxiOrderRequest = {
  currency: "₽", fixedPrice: true, from: fromPoint, payment: { id: "card-1", label: "карта MIR ••1234", type: "card" },
  porch: "2", price: 350, tariff: "econom", tariffName: "Эконом", to: toPoint,
};

function order(answers: TaxiAnswers) {
  const tab = fakeTaxiTab(pricedRoute(answers));
  return { place: (request: Partial<YandexTaxiOrderRequest> = {}) => createYandexTaxiClient({ driver: tab.driver, sleep: tab.sleep }).placeOrder({ ...confirmed, ...request }), tab };
}

const timeout = () => new ModelFacingError({ category: "operation", code: "AGENT_BROWSER_TIMEOUT", correction: "", reason: "", retryable: false, sideEffectStatus: "unknown" });

describe("placeYandexTaxiOrder", () => {
  it("drafts a confirmed ride once and commits it", async () => {
    const { place, tab } = order({ [PATHS.commit]: { data: { status: "search" } }, [PATHS.draft]: { data: { orderId: "o-1" } } });
    await expect(place({ comment: "Позвоните" })).resolves.toMatchObject({ orderId: "o-1", status: "search", statusText: "ищем машину" });
    expect(tab.to(PATHS.draft)).toHaveLength(1);
    expect(tab.to(PATHS.draft)[0]).toMatchObject({ phoneId: "phone-1", userId: "user-1" });
    expect(tab.to(PATHS.draft)[0]!.body).toEqual({
      class: ["econom"], comment: "Позвоните", dont_sms: false, driverclientchat_enabled: true, id: "user-1", location: [37.6, 55.7], offer: "offer-1", parks: [],
      payment: { payment_method_id: "card-1", type: "card" }, requirements: { coupon: "" },
      route: [
        { city: "Москва", fullname: fromPoint.fullText, geopoint: [37.6, 55.7], porchnumber: "2", short_text: "Корабельная 11к1", type: "a", uri: fromPoint.uri },
        { city: "Химки", fullname: toPoint.fullText, geopoint: [37.41, 55.98], porchnumber: "", short_text: "Шереметьево, терминал B", type: "b", uri: toPoint.uri },
      ],
    });
    expect(tab.to(PATHS.commit).map((call) => call.body)).toEqual([{ id: "user-1", orderid: "o-1" }]);
  });

  it("sends a Yandex card as yandex_card to the draft", async () => {
    const { place, tab } = order({ [PATHS.commit]: { data: { status: "search" } }, [PATHS.draft]: { data: { orderId: "o-1" } } });
    await place({ payment: { id: "ya-1", label: "Яндекс Карта", type: "yandex_card" } });
    expect(tab.to(PATHS.draft)[0]!.body.payment).toEqual({ payment_method_id: "ya-1", type: "yandex_card" });
  });

  it("orders nothing while another order is going on", async () => {
    const { place, tab } = order({ [PATHS.launch]: launchOk([{ orderId: "o-7", status: "transporting" }]) });
    await expect(place()).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_ORDER_ACTIVE", message: expect.stringContaining("o-7") });
    expect(tab.to(PATHS.routeStats)).toHaveLength(0);
    expect(tab.to(PATHS.draft)).toHaveLength(0);
  });

  it.each([
    ["the price (past the 5 % ceiling of 367)", { [PATHS.routeStats]: routeStats("368 $SIGN$") }, {}],
    ["the fixed flag", {}, { fixedPrice: false }],
    ["the currency", {}, { currency: "RUB" }],
    ["the tariff name", {}, { tariffName: "Эконом+" }],
  ] as const)("refuses a ride whose %s drifted since the estimate", async (_what, answers, request) => {
    const { place, tab } = order(answers);
    await expect(place(request)).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_PRICE_CHANGED" });
    expect(tab.to(PATHS.draft)).toHaveLength(0);
  });

  it.each([["lower", "330"], ["higher within the ceiling", "367"]])("orders at a %s fresh price with the fresh offer and says so", async (_what, fresh) => {
    const { place, tab } = order({ [PATHS.commit]: { data: { status: "search" } }, [PATHS.draft]: { data: { orderId: "o-1" } }, [PATHS.routeStats]: routeStats(`${fresh} $SIGN$`, "offer-fresh") });
    await expect(place()).resolves.toMatchObject({ currency: "₽", note: expect.stringContaining(`Цена при заказе ${fresh} ₽ (подтверждали 350 ₽)`), orderId: "o-1", price: Number(fresh) });
    expect(tab.to(PATHS.draft)[0]!.body.offer).toBe("offer-fresh");
  });

  it("refuses a payment the window did not name and a tariff that went away", async () => {
    const relabeled = order({});
    await expect(relabeled.place({ payment: { id: "card-1", label: "карта VISA ••9999", type: "card" } })).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_PAYMENT_CHANGED" });
    const gone = order({ [PATHS.payments]: { data: { cards: [], last: null, yandexCards: [] } } });
    await expect(gone.place()).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_PAYMENT_MISSING" });
    const range = order({});
    await expect(range.place({ price: 500, tariff: "business", tariffName: "Комфорт" })).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_TARIFF_UNAVAILABLE" });
    for (const { tab } of [relabeled, gone, range]) expect(tab.to(PATHS.draft)).toHaveLength(0);
  });

  it.each([
    ["a 5xx", { status: 502 } as const],
    ["no answer", { error: "network:TypeError", status: 0 } as const],
    ["an unreadable body", { error: "shape:orderid", status: 200 } as const],
    ["a browser timeout", timeout()],
  ])("never repeats a draft after %s and reports what launch shows", async (_what, reply) => {
    const { place, tab } = order({ [PATHS.draft]: reply, [PATHS.launch]: [launchOk(), launchOk([{ orderId: "o-5", status: "search" }])] });
    await expect(place()).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_ORDER_AMBIGUOUS", message: expect.stringContaining("o-5") });
    expect(tab.to(PATHS.draft)).toHaveLength(1);
    expect(tab.to(PATHS.commit)).toHaveLength(0);
    expect(tab.to(PATHS.launch)).toHaveLength(2);
  });

  it("marks a failure while re-pricing as having sent nothing", async () => {
    const { place, tab } = order({ [PATHS.routeStats]: { status: 503 } });
    const error = await place().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "AGENT_YANDEX_TAXI_UNAVAILABLE" });
    expect(isYandexTaxiNothingSent(error)).toBe(true);
    expect(tab.to(PATHS.draft)).toHaveLength(0);
  });

  it("tells a draft call that never started its request from one that started and then timed out", async () => {
    const notSent = order({ [PATHS.draft]: { error: "timeout", sent: false, stage: "csrf", status: 0 } });
    const error = await notSent.place().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "AGENT_YANDEX_TAXI_UNAVAILABLE" });
    expect(isYandexTaxiNothingSent(error)).toBe(true);
    expect(notSent.tab.to(PATHS.commit)).toHaveLength(0);
    const csrf = order({ [PATHS.draft]: { error: "csrf_failed", sent: false, status: 503 } });
    const csrfError = await csrf.place().catch((caught: unknown) => caught);
    expect(csrfError).toMatchObject({ code: "AGENT_YANDEX_TAXI_UNAVAILABLE" });
    expect(isYandexTaxiNothingSent(csrfError)).toBe(true);
    const commitCsrf = order({ [PATHS.commit]: { error: "csrf_failed", sent: false, status: 503 }, [PATHS.draft]: { data: { orderId: "o-1" } } });
    expect(isYandexTaxiNothingSent(await commitCsrf.place().catch((caught: unknown) => caught))).toBe(true);
    const started = order({ [PATHS.draft]: { error: "timeout", sent: true, stage: "send", status: 0 } });
    const ambiguous = await started.place().catch((caught: unknown) => caught);
    expect(ambiguous).toMatchObject({ code: "AGENT_YANDEX_TAXI_ORDER_AMBIGUOUS" });
    expect(isYandexTaxiNothingSent(ambiguous)).toBe(false);
  });

  it("names a draft the server refused instead of calling it ambiguous", async () => {
    const changed = order({ [PATHS.draft]: { code: "PRICE_CHANGED", message: "Цена изменилась", status: 406 } });
    await expect(changed.place()).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_PRICE_CHANGED" });
    const debt = order({ [PATHS.draft]: { code: "DEBT_USER", message: "Есть долг за прошлую поездку", status: 400 } });
    await expect(debt.place()).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_REJECTED", message: expect.stringContaining("долг") });
    const captcha = order({ [PATHS.draft]: { error: "captcha", status: 200 } });
    await expect(captcha.place()).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_CAPTCHA" });
    for (const { tab } of [changed, debt, captcha]) expect(tab.to(PATHS.commit)).toHaveLength(0);
  });

  it("repeats ordercommit only on 202, at the site's pace and at most four times", async () => {
    const accepted = order({ [PATHS.commit]: [{ error: "empty", status: 202 }, { error: "empty", status: 202 }, { data: { status: "search" } }], [PATHS.draft]: { data: { orderId: "o-1" } } });
    await expect(accepted.place()).resolves.toMatchObject({ orderId: "o-1" });
    expect(accepted.tab.to(PATHS.commit)).toHaveLength(3);
    expect(accepted.tab.sleep.mock.calls).toEqual([[5000], [5000]]);

    const stuck = order({ [PATHS.commit]: { error: "empty", status: 202 }, [PATHS.draft]: { data: { orderId: "o-1" } } });
    await expect(stuck.place()).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_ORDER_AMBIGUOUS", message: expect.stringContaining("o-1") });
    expect(stuck.tab.to(PATHS.commit)).toHaveLength(5);
    expect(stuck.tab.to(PATHS.draft)).toHaveLength(1);
  });

  it("never repeats a commit after an unclear outcome", async () => {
    for (const reply of [{ status: 500 }, { error: "not_json", status: 200 }, timeout()]) {
      const { place, tab } = order({ [PATHS.commit]: reply, [PATHS.draft]: { data: { orderId: "o-1" } } });
      await expect(place()).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_ORDER_AMBIGUOUS" });
      expect(tab.to(PATHS.commit)).toHaveLength(1);
      expect(tab.to(PATHS.draft)).toHaveLength(1);
    }
    // After a 202 the order is in flight: even a refusal is no longer proof that nothing was ordered.
    const late = order({ [PATHS.commit]: [{ error: "empty", status: 202 }, { code: "EXPIRED_ORDER", status: 400 }], [PATHS.draft]: { data: { orderId: "o-1" } } });
    await expect(late.place()).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_ORDER_AMBIGUOUS" });
    const refused = order({ [PATHS.commit]: { code: "EXPIRED_ORDER", message: "Заказ устарел", status: 400 }, [PATHS.draft]: { data: { orderId: "o-1" } } });
    await expect(refused.place()).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_REJECTED" });
  });
});

describe("cancelYandexTaxiOrder", () => {
  const view = (status: string, cancelState: string, cancelMessage = "") => ({ data: { cancelDisabled: false, cancelMessage, cancelState, car: "", driverName: "", finalCost: "", plates: "", rating: "", status, tariffClass: "econom", timeLeftSeconds: 300 } });
  const cancel = (answers: TaxiAnswers, request: { cancelMessage?: string; cancelState: "free" | "minimal" | "paid" | "unknown" }) => {
    const tab = fakeTaxiTab({ [PATHS.launch]: launchOk([{ orderId: "o-1", status: "driving" }]), ...answers });
    return { result: createYandexTaxiClient({ driver: tab.driver, sleep: tab.sleep }).cancel({ orderId: "o-1", ...request }), tab };
  };
  const breaks = (tab: ReturnType<typeof fakeTaxiTab>) => tab.to(PATHS.onTheWay).filter((call) => call.body.break === "user");

  it("sends break user once for the terms the person confirmed", async () => {
    const { result, tab } = cancel({ [PATHS.onTheWay]: [view("driving", "paid", "Отмена платная: 99 ₽"), { data: { status: "cancelled" } }] }, { cancelMessage: "Отмена платная: 99 ₽", cancelState: "paid" });
    await expect(result).resolves.toEqual({ cancelled: true, note: "Заказ отменён", orderId: "o-1", status: "cancelled" });
    expect(breaks(tab)).toHaveLength(1);
    expect(breaks(tab)[0]!.body).toEqual({ break: "user", format_currency: true, id: "user-1", orderid: "o-1", show_text: true });
  });

  it("refuses changed terms, a finished order and a disabled cancellation without sending", async () => {
    const turnedPaid = cancel({ [PATHS.onTheWay]: view("driving", "paid", "Отмена платная: 99 ₽") }, { cancelState: "free" });
    await expect(turnedPaid.result).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_CANCEL_CHANGED" });
    const pricier = cancel({ [PATHS.onTheWay]: view("driving", "paid", "Отмена платная: 199 ₽") }, { cancelMessage: "Отмена платная: 99 ₽", cancelState: "paid" });
    await expect(pricier.result).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_CANCEL_CHANGED" });
    const finished = cancel({ [PATHS.onTheWay]: view("complete", "free") }, { cancelState: "free" });
    await expect(finished.result).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_CANCEL_UNAVAILABLE" });
    const disabled = cancel({ [PATHS.onTheWay]: view("transporting", "disabled") }, { cancelState: "free" });
    await expect(disabled.result).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_CANCEL_UNAVAILABLE" });
    for (const { tab } of [turnedPaid, pricier, finished, disabled]) expect(breaks(tab)).toHaveLength(0);
  });

  it("calls an unclear cancellation ambiguous and does not repeat it", async () => {
    const { result, tab } = cancel({ [PATHS.onTheWay]: [view("driving", "free"), { status: 503 }] }, { cancelState: "free" });
    await expect(result).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_CANCEL_AMBIGUOUS" });
    expect(breaks(tab)).toHaveLength(1);
  });
});
