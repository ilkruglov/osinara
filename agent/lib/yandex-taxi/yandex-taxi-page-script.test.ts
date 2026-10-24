/**
 * The in-page Yandex Go script, executed in Node against a fake tab.
 *
 * Constructs covered:
 * - Nothing is sent from a tab that is no longer on taxi.yandex.ru.
 * - The request goes to the API host with the site's headers, the cached or fetched CSRF token and
 *   the page's credentials; the person's text reaches the page only as a JSON literal.
 * - INVALID_CSRF_TOKEN is retried once with a fresh token, a 401 once after a Passport refresh; a
 *   captcha answer is reported, not solved.
 * - Projections keep the fields the tool uses, ignore extra ones, refuse a missing required one,
 *   keep the last used card through the cut, and pass a refusal's code and text.
 * - launch sends the user id the site stored in IndexedDB, and never creates that database.
 * - A request that never settles still lets the call settle by the page deadline, with the step and
 *   whether a request the server may act on was out; after the deadline nothing more is sent. A CSRF
 *   failure and a refusal before reading report nothing sent. The site's error code passes only when
 *   it looks like one.
 */
import { describe, expect, it, vi } from "vitest";

import type { YandexTaxiPageRequest } from "./yandex-taxi-page-script.js";
import { yandexTaxiPageScript } from "./yandex-taxi-page-script.js";

type Reply = { body: unknown; status: number };
interface TabOptions { cachedToken?: { token: string; validUntil: number } | null; csrfDelayMs?: number; csrfStatus?: number; hang?: "api" | "csrf"; hostname?: string; indexedDB?: unknown; passport?: unknown; replies?: Reply[] }

function runInFakeTab(request: YandexTaxiPageRequest, options: TabOptions = {}) {
  const replies = [...(options.replies ?? [{ body: {}, status: 200 }])];
  const fetch = vi.fn(async (url: string) => {
    if (options.hang === "csrf" && url.endsWith("/csrf_token")) return await new Promise<never>(() => {});
    if (options.hang === "api" && !url.endsWith("/csrf_token")) return await new Promise<never>(() => {});
    if (url.endsWith("/csrf_token") && options.csrfDelayMs) await new Promise((resolve) => setTimeout(resolve, options.csrfDelayMs));
    if (url.endsWith("/csrf_token") && options.csrfStatus) return { ok: false, status: options.csrfStatus, text: async () => "" };
    if (url.endsWith("/csrf_token")) return { ok: true, status: 200, text: async () => JSON.stringify({ "max-age-seconds": 3600, sk: `fresh-${fetch.mock.calls.length}` }) };
    if (url.startsWith("https://passport.yandex.ru/")) return { ok: true, status: 200, text: async () => JSON.stringify(options.passport ?? { status: "error" }) };
    const reply = replies.shift() ?? { body: {}, status: 200 };
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, text: async () => typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body) };
  });
  const localStorage = { getItem: vi.fn(() => options.cachedToken === undefined ? null : JSON.stringify(options.cachedToken)) };
  const window = { clientConfig: { requestId: "req-1" } };
  const navigator = { userAgent: "Mozilla/5.0 Chrome/152" };
  const location = { hostname: options.hostname ?? "taxi.yandex.ru", origin: "https://taxi.yandex.ru" };
  // oxlint-disable-next-line typescript/no-implied-eval -- the fixed page script runs against a fake tab
  const run = new Function("fetch", "localStorage", "window", "navigator", "location", "indexedDB", `return ${yandexTaxiPageScript(request)};`) as (...args: unknown[]) => Promise<string>;
  const result = run(fetch, localStorage, window, navigator, location, options.indexedDB).then((text) => JSON.parse(text) as { code?: string; data: unknown; error: string | null; message?: string; status: number });
  return { fetch, result };
}

const apiCalls = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.filter(([url]) => String(url).startsWith("https://ya-authproxy.taxi.yandex.ru/") && !String(url).endsWith("/csrf_token")) as unknown as Array<[string, { body: string; credentials: string; headers: Record<string, string>; method: string }]>;

describe("yandexTaxiPageScript", () => {
  it("sends nothing from a tab that is no longer on taxi.yandex.ru", async () => {
    const { fetch, result } = runInFakeTab({ body: { route: [] }, endpoint: "orderDraft", project: "draft" }, { hostname: "evil.example" });
    expect(await result).toEqual({ data: null, error: "wrong_origin:evil.example", status: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts to the API host with the site's headers, the cached CSRF token and the page's credentials", async () => {
    const { fetch, result } = runInFakeTab(
      { body: { part: "Тверская '1'\"" }, endpoint: "suggest", phoneId: "phone-1", project: "suggest", userId: "user-1" },
      { cachedToken: { token: "cached", validUntil: Date.now() + 60_000 }, replies: [{ body: { results: [] }, status: 200 }] },
    );
    expect(await result).toEqual({ data: [], error: null, status: 200 });
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/csrf_token"))).toBe(false);
    const [url, init] = apiCalls(fetch)[0]!;
    expect(url).toBe("https://ya-authproxy.taxi.yandex.ru/4.0/persuggest/v1/suggest");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(init.headers).toMatchObject({
      "accept-language": "ru", "content-type": "application/json", "x-csrf-token": "cached", "x-personal-phone-id": "phone-1", "x-request-id": "req-1",
      "x-requested-with": "XMLHttpRequest", "x-retpath-y": "https://taxi.yandex.ru/captcha-success", "x-taxi": "Mozilla/5.0 Chrome/152 turboapp_taxi", "x-yataxi-userid": "user-1",
    });
    expect(JSON.parse(init.body)).toEqual({ part: "Тверская '1'\"" });
  });

  it("retries an INVALID_CSRF_TOKEN refusal once with a fresh token", async () => {
    const { fetch, result } = runInFakeTab({ body: {}, endpoint: "userPlaces", project: "places", userId: "u" }, {
      cachedToken: { token: "stale", validUntil: Date.now() + 60_000 },
      replies: [{ body: { code: "INVALID_CSRF_TOKEN" }, status: 403 }, { body: { places: [] }, status: 200 }],
    });
    expect(await result).toEqual({ data: [], error: null, status: 200 });
    const calls = apiCalls(fetch);
    expect(calls).toHaveLength(2);
    expect(calls[0]![1].headers["x-csrf-token"]).toBe("stale");
    expect(calls[1]![1].headers["x-csrf-token"]).toMatch(/^fresh-/u);
  });

  it("refreshes the Passport session once on 401 and reports a second 401", async () => {
    const refreshed = runInFakeTab({ body: {}, endpoint: "userPlaces", project: "places" }, { passport: { status: "ok" }, replies: [{ body: {}, status: 401 }, { body: { places: [] }, status: 200 }] });
    expect(await refreshed.result).toEqual({ data: [], error: null, status: 200 });
    expect(refreshed.fetch.mock.calls.filter(([url]) => String(url) === "https://passport.yandex.ru/auth/update/")).toHaveLength(1);
    const lost = runInFakeTab({ body: {}, endpoint: "userPlaces", project: "places" }, { passport: { status: "error" }, replies: [{ body: {}, status: 401 }] });
    expect((await lost.result).status).toBe(401);
    expect(apiCalls(lost.fetch)).toHaveLength(1);
  });

  it("passes the site's error code only when it looks like a code", async () => {
    const text = await runInFakeTab({ body: {}, endpoint: "orderDraft", project: "draft" }, { replies: [{ body: { error: "Адрес Тверская 1 не найден" }, status: 400 }] }).result;
    expect(text.code).toBe("UNKNOWN");
    const code = await runInFakeTab({ body: {}, endpoint: "orderDraft", project: "draft" }, { replies: [{ body: { error: { code: "order.not_found" } }, status: 404 }] }).result;
    expect(code.code).toBe("order.not_found");
  });

  it("settles by the page deadline when a request never does, saying whether the main request started", async () => {
    vi.useFakeTimers();
    try {
      const atCsrf = runInFakeTab({ body: {}, endpoint: "orderDraft", project: "draft" }, { hang: "csrf" }).result;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await atCsrf).toEqual({ data: null, error: "timeout", sent: false, stage: "csrf", status: 0 });
      const atSend = runInFakeTab({ body: {}, endpoint: "orderDraft", project: "draft" }, { cachedToken: { token: "cached", validUntil: Date.now() + 60_000 }, hang: "api" }).result;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await atSend).toEqual({ data: null, error: "timeout", sent: true, stage: "send", status: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends nothing after the deadline, even when a slow step finishes later", async () => {
    vi.useFakeTimers();
    try {
      const { fetch, result } = runInFakeTab({ body: {}, endpoint: "orderCommit", project: "commit" }, { csrfDelayMs: 35_000 });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await result).toEqual({ data: null, error: "timeout", sent: false, stage: "csrf", status: 0 });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(apiCalls(fetch)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports nothing sent for a CSRF failure and for a repeat whose fresh token failed", async () => {
    const failed = await runInFakeTab({ body: {}, endpoint: "orderDraft", project: "draft" }, { csrfStatus: 503 }).result;
    expect(failed).toEqual({ data: null, error: "csrf_failed", sent: false, status: 503 });
    const { fetch, result } = runInFakeTab({ body: {}, endpoint: "orderDraft", project: "draft" }, {
      cachedToken: { token: "stale", validUntil: Date.now() + 60_000 }, csrfStatus: 503, replies: [{ body: { code: "INVALID_CSRF_TOKEN" }, status: 403 }],
    });
    expect(await result).toEqual({ data: null, error: "csrf_failed", sent: false, status: 503 });
    expect(apiCalls(fetch)).toHaveLength(1);
  });

  it("reports a captcha and a refusal without guessing", async () => {
    const captcha = await runInFakeTab({ body: {}, endpoint: "routeStats", project: "routestats" }, { replies: [{ body: { captcha: { "captcha-page": "https://x" }, type: "captcha" }, status: 200 }] }).result;
    expect(captcha).toEqual({ data: null, error: "captcha", status: 200 });
    const refused = await runInFakeTab({ body: {}, endpoint: "orderDraft", project: "draft" }, { replies: [{ body: { code: "PRICE_CHANGED", text: "Цена изменилась" }, status: 406 }] }).result;
    expect(refused).toEqual({ code: "PRICE_CHANGED", data: null, error: null, message: "Цена изменилась", status: 406 });
    const html = await runInFakeTab({ body: {}, endpoint: "orderCommit", project: "commit" }, { replies: [{ body: "<html>", status: 200 }] }).result;
    expect(html).toEqual({ data: null, error: "not_json", status: 200 });
    const accepted = await runInFakeTab({ body: {}, endpoint: "orderCommit", project: "commit" }, { replies: [{ body: "", status: 202 }] }).result;
    expect(accepted).toEqual({ data: null, error: "empty", status: 202 });
  });

  it("refuses an answer without a required field and ignores extra ones", async () => {
    const noOffer = await runInFakeTab({ body: {}, endpoint: "routeStats", project: "routestats" }, { replies: [{ body: { service_levels: [] }, status: 200 }] }).result;
    expect(noOffer).toEqual({ data: null, error: "shape:offer", status: 200 });
    const stats = await runInFakeTab({ body: {}, endpoint: "routeStats", project: "routestats" }, { replies: [{ body: {
      currency_rules: { sign: "₽", text: "руб." }, extra: { huge: "x".repeat(50_000) }, offer: "offer-1",
      service_levels: [{ class: "econom", estimated_waiting: { seconds: 190 }, is_fixed_price: true, price: "~350 $SIGN$$CURRENCY$", promo: {} }, { class: "vip", is_hidden: true, price: "900 $SIGN$", tariff_unavailable: { code: "x" } }, { price: "no class" }],
    }, status: 200 }] }).result;
    expect(stats.data).toEqual({
      currencySign: "₽", currencyText: "руб.", offer: "offer-1",
      levels: [
        { class: "econom", fixed: true, hidden: false, price: "~350 $SIGN$$CURRENCY$", unavailable: false, waitingSeconds: 190 },
        { class: "vip", fixed: false, hidden: true, price: "900 $SIGN$", unavailable: true, waitingSeconds: null },
      ],
    });
    const launch = await runInFakeTab({ body: {}, endpoint: "launch", project: "launch" }, { replies: [{ body: { authorized: true, id: "u1", orders: [{ orderid: "o1", status: "driving" }, { status: "search" }], personal_phone_id: "p1", payment_statuses_filter: ["debt"] }, status: 200 }] }).result;
    expect(launch.data).toEqual({ authorized: true, blocked: false, debt: true, orders: [{ orderId: "o1", status: "driving" }, { orderId: "", status: "search" }], phoneId: "p1", userId: "u1" });
    const noAuthorized = await runInFakeTab({ body: {}, endpoint: "launch", project: "launch" }, { replies: [{ body: { id: "u1" }, status: 200 }] }).result;
    expect(noAuthorized.error).toBe("shape:authorized");
  });

  it("projects places, finalized points, payments and an order down to what the tool shows", async () => {
    const places = await runInFakeTab({ body: {}, endpoint: "userPlaces", project: "places" }, { replies: [{ body: { places: [
      { address: { city: "Москва", full_text: "Россия, Москва, Корабельная 11к1", point: [37.6, 55.7], short_text: "Корабельная 11к1", uri: "ymapsbm1://geo?x" }, id: "p1", name: "Дом", version: 3 },
      { address: { full_text: "без координат" }, name: "Сломанное" },
    ] }, status: 200 }] }).result;
    expect(places.data).toEqual([{ name: "Дом", point: { city: "Москва", fullText: "Россия, Москва, Корабельная 11к1", lat: 55.7, lon: 37.6, shortText: "Корабельная 11к1", uri: "ymapsbm1://geo?x" } }]);

    const finalized = await runInFakeTab({ body: {}, endpoint: "finalSuggest", project: "finalize" }, { replies: [{ body: {
      results: [{ city: "Москва", entrance: "2", log: "{}", position: [37.5, 55.8], text: "Россия, Москва, Тверская 1", title: { text: "Тверская 1" }, uri: "u" }],
      services: { taxi: { available: true, nearest_zone: "moscow" } },
    }, status: 200 }] }).result;
    expect(finalized.data).toEqual({ available: true, entrance: "2", point: { city: "Москва", fullText: "Россия, Москва, Тверская 1", lat: 55.8, lon: 37.5, shortText: "Тверская 1", uri: "u" }, unavailableReason: "", zone: "moscow" });

    const cards = Array.from({ length: 15 }, (_, i) => ({ id: `card-${i}`, number: `510000****${String(1000 + i)}`, system: "MIR" }));
    const payments = await runInFakeTab({ body: {}, endpoint: "paymentMethods", project: "payments" }, { replies: [{ body: {
      card: { available_cards: cards, unverified_cards: [{ id: "card-new", number: "220000****5555", usable: false }] }, last_payment_method: { id: "card-14", type: "card" }, yandex_card: { available_cards: [{ availability: { available: false }, card_id: "ya-off" }, { card_id: "ya-1" }] },
    }, status: 200 }] }).result;
    const data = payments.data as { cards: Array<{ id: string; last4: string }>; last: unknown; unverifiedCardIds: unknown; yandexCards: unknown };
    expect(data.unverifiedCardIds).toEqual(["card-new"]);
    expect(data.cards).toHaveLength(10);
    expect(data.cards[0]).toEqual({ id: "card-14", last4: "1014", system: "MIR" });
    expect(data.last).toEqual({ id: "card-14", type: "card" });
    expect(data.yandexCards).toEqual([{ id: "ya-1" }]);

    const order = await runInFakeTab({ body: {}, endpoint: "taxiOnTheWay", project: "order" }, { replies: [{ body: {
      cancel_rules: { message: "Отмена платная: 99 ₽", state: "paid" }, cancel_state: { state: "paid" }, driver: { color: "белый", model: "Kia Rio", name: "Иван", phone: "+7…", plates: "А123ВС77", rating: "4.9" },
      routeinfo: { time_left: 125 }, status: "driving", tariff: { class: "econom" },
    }, status: 200 }] }).result;
    expect(order.data).toEqual({ cancelDisabled: false, cancelMessage: "Отмена платная: 99 ₽", cancelState: "paid", car: "белый Kia Rio", driverName: "Иван", finalCost: "", plates: "А123ВС77", rating: "4.9", status: "driving", tariffClass: "econom", timeLeftSeconds: 125 });
  });

  it("sends the user id the site keeps in IndexedDB with launch and never creates the database", async () => {
    const store = { get: () => { const request = { onerror: null, onsuccess: null as null | (() => void), result: JSON.stringify({ userId: JSON.stringify("stored-1") }) }; setTimeout(() => request.onsuccess?.()); return request; } };
    const db = { close: vi.fn(), objectStoreNames: { contains: (name: string) => name === "redux-persist" }, transaction: () => ({ objectStore: () => store }) };
    const indexedDB = {
      databases: async () => [{ name: "turboapp-taxi" }],
      open: () => { const request = { onerror: null, onsuccess: null as null | (() => void), result: db }; setTimeout(() => request.onsuccess?.()); return request; },
    };
    const { fetch, result } = runInFakeTab({ body: {}, endpoint: "launch", project: "launch", useStoredUserId: true }, { indexedDB, replies: [{ body: { authorized: true, id: "stored-1" }, status: 200 }] });
    expect((await result).status).toBe(200);
    const [url, init] = apiCalls(fetch)[0]!;
    expect(url).toBe("https://ya-authproxy.taxi.yandex.ru/3.0/launch?");
    expect(JSON.parse(init.body)).toEqual({ id: "stored-1" });
    expect(init.headers["x-yataxi-userid"]).toBe("stored-1");
    expect(db.close).toHaveBeenCalled();

    const absent = { databases: async () => [], open: vi.fn() };
    const fresh = runInFakeTab({ body: {}, endpoint: "launch", project: "launch", useStoredUserId: true }, { indexedDB: absent, replies: [{ body: { authorized: false, id: "new" }, status: 200 }] });
    expect((await fresh.result).data).toMatchObject({ authorized: false, userId: "new" });
    expect(absent.open).not.toHaveBeenCalled();
    expect(JSON.parse(apiCalls(fresh.fetch)[0]![1].body)).toEqual({});
  });
});
