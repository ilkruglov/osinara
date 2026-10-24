/**
 * Yandex Go client over a fake browser tab: everything that spends no money.
 *
 * Constructs covered:
 * - A tab on another site is navigated to taxi.yandex.ru; one that does not land there is refused.
 * - auth reports login, an unconfirmed phone and active orders; other actions turn the same states
 *   into named errors, as they do a block, a captcha and an answer without a required field.
 * - places and suggest return points with keys; suggest finalizes the picked candidate with its log
 *   and lists the others without it.
 * - estimate refuses an edited point before any call, prices the route like the site (zone tariffs,
 *   hidden levels dropped, a range has no exact price) and never picks an unchosen card.
 * - status follows the active order and maps the driver, the car and the minutes left.
 */
import { describe, expect, it } from "vitest";

import { createYandexTaxiClient } from "./yandex-taxi-client.js";
import { yandexTaxiPointKey, yandexTaxiPriceValue } from "./yandex-taxi-model.js";
import { fakeTaxiTab, fromPoint, launchOk, PATHS, pricedRoute, toPoint } from "./yandex-taxi.test-fixtures.js";

const client = (tab: ReturnType<typeof fakeTaxiTab>) => createYandexTaxiClient({ driver: tab.driver, sleep: tab.sleep });

describe("createYandexTaxiClient", () => {
  it("runs from the static page of taxi.yandex.ru, never from another site or the site's app, and refuses a tab that does not land there", async () => {
    for (const start of ["https://passport.yandex.ru/auth", "https://taxi.yandex.ru/"]) {
      const tab = fakeTaxiTab({ [PATHS.launch]: launchOk() }, start);
      await client(tab).auth();
      expect(tab.driver.open, start).toHaveBeenCalledWith("https://taxi.yandex.ru/robots.txt");
      expect(tab.driver.settle).toHaveBeenCalled();
    }
    const ready = fakeTaxiTab({ [PATHS.launch]: launchOk() });
    await client(ready).auth();
    expect(ready.driver.open).not.toHaveBeenCalled();

    const redirected = fakeTaxiTab({ [PATHS.launch]: launchOk() }, "https://passport.yandex.ru/auth");
    redirected.driver.open.mockImplementation(async () => {});
    await expect(client(redirected).auth()).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_TAB_UNAVAILABLE" });
    expect(redirected.driver.eval).not.toHaveBeenCalled();
  });

  it("reports the login state and lists only orders that are still going on", async () => {
    await expect(client(fakeTaxiTab({ [PATHS.launch]: { status: 401 } })).auth()).resolves.toMatchObject({ state: "login_required" });
    await expect(client(fakeTaxiTab({ [PATHS.launch]: { data: { ...launchOk().data as object, authorized: false } } })).auth()).resolves.toMatchObject({ state: "phone_unconfirmed" });
    await expect(client(fakeTaxiTab({ [PATHS.launch]: { status: 403 } })).auth()).resolves.toMatchObject({ state: "blocked" });
    const orders = [{ orderId: "o1", status: "draft" }, { orderId: "o2", status: "complete" }, { orderId: "o3", status: "driving" }, { orderId: "o4", status: "new_unknown" }];
    await expect(client(fakeTaxiTab({ [PATHS.launch]: launchOk(orders) })).auth()).resolves.toEqual({
      activeOrders: [{ orderId: "o3", status: "driving" }, { orderId: "o4", status: "new_unknown" }], debt: false, state: "ready",
    });
  });

  it("names a lost login, an unconfirmed phone, a block, a captcha and a broken answer", async () => {
    const places = (answers: Parameters<typeof fakeTaxiTab>[0]) => client(fakeTaxiTab(answers)).places();
    await expect(places({ [PATHS.launch]: { status: 401 } })).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_AUTH_REQUIRED", message: expect.stringContaining("passport.yandex.ru/auth") });
    await expect(places({ [PATHS.launch]: { data: { ...launchOk().data as object, authorized: false } } })).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_AUTH_REQUIRED", message: expect.stringContaining("телефон") });
    await expect(places({ [PATHS.launch]: { data: { ...launchOk().data as object, blocked: true } } })).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_BLOCKED" });
    await expect(places({ [PATHS.launch]: { error: "captcha" } })).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_CAPTCHA" });
    await expect(places({ [PATHS.launch]: launchOk(), [PATHS.places]: { error: "shape:places" } })).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_RESPONSE_INVALID" });
    await expect(places({ [PATHS.launch]: launchOk(), [PATHS.places]: { error: "network:TypeError", status: 0 } })).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_UNAVAILABLE" });
    await expect(places({ [PATHS.launch]: launchOk(), [PATHS.places]: { error: "wrong_origin:evil.example", status: 0 } })).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_TAB_MOVED" });
  });

  it("returns saved places as keyed points under the session's user id", async () => {
    const tab = fakeTaxiTab({ [PATHS.launch]: launchOk(), [PATHS.places]: { data: [{ name: "Дом", point: { ...fromPoint, key: undefined } }] } });
    const { places } = await client(tab).places();
    expect(places[0]).toEqual({ name: "Дом", point: fromPoint });
    expect(tab.to(PATHS.places)[0]).toMatchObject({ body: { id: "user-1" }, userId: "user-1" });
    expect(tab.to(PATHS.launch)[0]).toMatchObject({ body: {}, useStoredUserId: true });
  });

  it("finalizes the picked suggestion with its log and lists the others without it", async () => {
    const results = [
      { log: { serp: 1 }, position: [37.5, 55.8], subtitle: "Москва", title: "Тверская 1" },
      { log: { serp: 2 }, position: null, subtitle: "Тверь", title: "Тверская 1, Тверь" },
    ];
    const finalized = { available: true, entrance: "3", point: { city: "Тверь", fullText: "Россия, Тверь, Тверская 1", lat: 56.8, lon: 35.9, shortText: "Тверская 1", uri: "u2" }, unavailableReason: "", zone: "tver" };
    const tab = fakeTaxiTab({ [PATHS.finalize]: { data: finalized }, [PATHS.launch]: launchOk(), [PATHS.suggest]: { data: results } });
    const found = await client(tab).suggest({ near: { lat: 56.85, lon: 35.9 }, pick: 1, query: "Тверская 1", type: "b" });
    expect(found.point.key).toBe(yandexTaxiPointKey(finalized.point));
    expect(found.entrance).toBe("3");
    expect(found.others).toEqual([{ pick: 0, subtitle: "Москва", title: "Тверская 1" }]);
    expect(JSON.stringify(found)).not.toContain("serp");
    expect(tab.to(PATHS.suggest)[0]!.body).toMatchObject({ action: "user_input", client_id: "turboapp-taxi", part: "Тверская 1", state: { location: [35.9, 56.85] }, type: "b" });
    expect(tab.to(PATHS.finalize)[0]!.body).toEqual({ action: "finalize", prev_log: { serp: 2 }, state: { accuracy: 0, fields: [], location: [35.9, 56.85], selected_class: "" }, sticky: false, type: "b" });
    const none = fakeTaxiTab({ [PATHS.launch]: launchOk(), [PATHS.suggest]: { data: [] } });
    await expect(client(none).suggest({ pick: 0, query: "нигде", type: "a" })).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_ADDRESS_NOT_FOUND" });
  });

  it("refuses an edited point before calling anything", async () => {
    const tab = fakeTaxiTab(pricedRoute());
    await expect(client(tab).estimate({ from: { ...fromPoint, shortText: "Красная площадь" }, to: toPoint })).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_POINT_REF_INVALID" });
    await expect(client(tab).estimate({ from: fromPoint, to: { ...toPoint, lat: 55.0 } })).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_POINT_REF_INVALID" });
    expect(tab.driver.eval).not.toHaveBeenCalled();
  });

  it("prices the route like the site and pays with the last used method", async () => {
    const tab = fakeTaxiTab(pricedRoute());
    const estimate = await client(tab).estimate({ from: fromPoint, to: toPoint });
    expect(estimate).toMatchObject({ currency: "₽", from: fromPoint, payment: { id: "card-1", label: "карта MIR ••1234", type: "card" }, to: toPoint });
    expect(estimate.tariffs).toEqual([
      { available: true, fixedPrice: true, price: 350, tariff: "econom", tariffName: "Эконом", waitingMinutes: 4 },
      { available: false, fixedPrice: false, price: null, tariff: "business", tariffName: "Комфорт", waitingMinutes: null },
    ]);
    expect(estimate.paymentOptions.map((option) => option.label)).toEqual(["наличные", "карта MIR ••1234", "Яндекс Карта"]);
    expect(tab.to(PATHS.finalize)[0]!.body).toMatchObject({ action: "pin_drop", position: [37.6, 55.7], type: "a" });
    expect(tab.to(PATHS.zone)[0]!.body).toMatchObject({ id: "user-1", zone_name: "moscow" });
    const stats = tab.to(PATHS.routeStats)[0]!;
    expect(stats).toMatchObject({ phoneId: "phone-1", userId: "user-1" });
    expect(stats.body).toMatchObject({
      format_currency: true, id: "user-1", payment: { payment_method_id: "card-1", type: "card" }, route: [[37.6, 55.7], [37.41, 55.98]], selected_class: "",
      tariff_requirements: [{ class: "econom-id", requirements: { coupon: "" } }, { class: "business", requirements: { coupon: "" } }, { class: "vip", requirements: { coupon: "" } }],
    });
  });

  it("prices cash and a Yandex card on request and never picks a card nobody chose", async () => {
    const cash = fakeTaxiTab(pricedRoute());
    await expect(client(cash).estimate({ from: fromPoint, payment: { type: "cash" }, to: toPoint })).resolves.toMatchObject({ payment: { id: "cash", label: "наличные", type: "cash" } });
    expect(cash.to(PATHS.routeStats)[0]!.body.payment).toEqual({ type: "cash" });
    const yandex = fakeTaxiTab(pricedRoute());
    await expect(client(yandex).estimate({ from: fromPoint, payment: { id: "ya-1", type: "yandex_card" }, to: toPoint })).resolves.toMatchObject({ payment: { label: "Яндекс Карта", type: "yandex_card" } });
    expect(yandex.to(PATHS.routeStats)[0]!.body.payment).toEqual({ payment_method_id: "ya-1", type: "card" });
    const noLast = fakeTaxiTab(pricedRoute({ [PATHS.payments]: { data: { cards: [{ id: "card-1", last4: "1234", system: "MIR" }], last: null, yandexCards: [] } } }));
    await expect(client(noLast).estimate({ from: fromPoint, to: toPoint })).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_PAYMENT_MISSING" });
    const corp = fakeTaxiTab(pricedRoute({ [PATHS.payments]: { data: { cards: [{ id: "card-1", last4: "1234", system: "MIR" }], last: { id: "corp-1", type: "corp" }, yandexCards: [] } } }));
    await expect(client(corp).estimate({ from: fromPoint, to: toPoint })).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_PAYMENT_MISSING" });
    expect(corp.to(PATHS.routeStats)).toHaveLength(0);
    // As in the live answer of 24 October 2026: the last card waits for verification in the app.
    const unverified = fakeTaxiTab(pricedRoute({ [PATHS.payments]: { data: { cards: [], last: { id: "card-9", type: "card" }, unverifiedCardIds: ["card-9"], yandexCards: [{ id: "ya-1" }] } } }));
    await expect(client(unverified).estimate({ from: fromPoint, to: toPoint })).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_PAYMENT_MISSING", message: expect.stringContaining("ждёт подтверждения") });
  });

  it("refuses a pickup point the service does not cover", async () => {
    const tab = fakeTaxiTab(pricedRoute({ [PATHS.finalize]: { data: { available: false, entrance: "", point: fromPoint, unavailableReason: "Здесь не работаем", zone: "" } } }));
    await expect(client(tab).estimate({ from: fromPoint, to: toPoint })).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_ZONE_UNAVAILABLE", message: expect.stringContaining("Здесь не работаем") });
  });

  it("follows the active order in status and maps the driver, the car and the minutes left", async () => {
    const order = { cancelDisabled: false, cancelMessage: "", cancelState: "free", car: "белый Kia Rio", driverName: "Иван", finalCost: "", plates: "А123ВС77", rating: "4.9", status: "driving", tariffClass: "econom", timeLeftSeconds: 125 };
    const tab = fakeTaxiTab({ [PATHS.launch]: launchOk([{ orderId: "o-9", status: "driving" }]), [PATHS.onTheWay]: { data: order } });
    await expect(client(tab).status()).resolves.toMatchObject({ order: { car: "белый Kia Rio", driver: "Иван", minutesLeft: 3, orderId: "o-9", plates: "А123ВС77", status: "driving", statusText: "машина едет к вам" } });
    expect(tab.to(PATHS.onTheWay)[0]).toMatchObject({ body: { format_currency: true, id: "user-1", orderid: "o-9", show_text: true }, phoneId: "phone-1" });
    expect(tab.to(PATHS.onTheWay)[0]!.body).not.toHaveProperty("break");
    await expect(client(fakeTaxiTab({ [PATHS.launch]: launchOk() })).status()).resolves.toEqual({ activeOrders: [], order: null });
    await expect(client(fakeTaxiTab({ [PATHS.launch]: launchOk(), [PATHS.onTheWay]: { status: 404 } })).status("gone")).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_ORDER_NOT_FOUND" });
  });
});

describe("yandexTaxiPriceValue", () => {
  it("reads the one number of a price template and refuses ranges", () => {
    expect(yandexTaxiPriceValue("~350 $SIGN$$CURRENCY$")).toBe(350);
    expect(yandexTaxiPriceValue("1 234,50 ₽")).toBe(1234.5);
    expect(yandexTaxiPriceValue("<b>99</b> $SIGN$")).toBe(99);
    expect(yandexTaxiPriceValue("от 500 до 600 ₽")).toBeNull();
    expect(yandexTaxiPriceValue("")).toBeNull();
  });
});
