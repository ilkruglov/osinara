/**
 * A fake taxi.yandex.ru tab for client tests: answers page-script calls by API path.
 *
 * Exports:
 * - `fakeTaxiTab`: a driver whose `eval` reads the request literal from the page script and replies
 *   with a page result per path (a list is consumed in order, its last entry repeats; a function
 *   sees the request body; an Error is thrown as the browser would).
 * - Fixtures of one session, one zone, one account's payment methods and one priced route.
 */
import { vi } from "vitest";

import { withYandexTaxiPointKey } from "./yandex-taxi-model.js";

// Route point keys are signed with the installation secret; tests sign with a fixed one.
process.env.INVITATION_SIGNING_SECRET ??= "yandex-taxi-test-signing-secret-0123456789";
import type { YandexTaxiPageResult } from "./yandex-taxi-page-script.js";

type Reply = Partial<YandexTaxiPageResult> | Error | ((body: Record<string, unknown>) => Partial<YandexTaxiPageResult> | Error);
export type TaxiAnswers = Record<string, Reply | Reply[]>;

export interface TaxiCall { body: Record<string, unknown>; path: string; phoneId: string; project: string; useStoredUserId: boolean; userId: string; }

export const PATHS = {
  commit: "/external/3.0/ordercommit",
  draft: "/external/3.0/orderdraft",
  finalize: "/4.0/persuggest/v1/finalsuggest",
  launch: "/3.0/launch?",
  onTheWay: "/3.0/taxiontheway",
  payments: "/3.0/paymentmethods",
  places: "/3.0/userplaces",
  routeStats: "/3.0/routestats",
  suggest: "/4.0/persuggest/v1/suggest",
  zone: "/3.0/zoneinfo",
} as const;

export function fakeTaxiTab(answers: TaxiAnswers, url = "https://taxi.yandex.ru/robots.txt") {
  const calls: TaxiCall[] = [];
  const queues = new Map(Object.entries(answers).map(([path, reply]) => [path, Array.isArray(reply) ? [...reply] : [reply]]));
  let current = url;
  const driver = {
    eval: vi.fn(async (script: string) => {
      const request = JSON.parse(/const req = (\{.*?\});\n/su.exec(script)![1]!) as TaxiCall;
      calls.push(request);
      const queue = queues.get(request.path);
      if (!queue) throw new Error(`no answer for ${request.path}`);
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      const reply = typeof next === "function" ? next(request.body) : next;
      if (reply instanceof Error) throw reply;
      return JSON.stringify({ data: null, error: null, status: 200, ...reply });
    }),
    open: vi.fn(async (next: string) => { current = next; }),
    settle: vi.fn(async () => {}),
    url: vi.fn(async () => current),
  };
  const sleep = vi.fn(async (_ms: number) => {});
  return { calls, driver, sleep, to: (path: string) => calls.filter((call) => call.path === path) };
}

export const launchOk = (orders: Array<{ orderId: string; status: string }> = []): Partial<YandexTaxiPageResult> => ({
  data: { authorized: true, blocked: false, debt: false, orders, phoneId: "phone-1", userId: "user-1" },
});

export const fromPoint = withYandexTaxiPointKey({ city: "Москва", fullText: "Россия, Москва, Корабельная улица, 11к1", lat: 55.7, lon: 37.6, shortText: "Корабельная 11к1", uri: "ymapsbm1://geo?a" });
export const toPoint = withYandexTaxiPointKey({ city: "Химки", fullText: "Россия, Химки, аэропорт Шереметьево, терминал B", lat: 55.98, lon: 37.41, shortText: "Шереметьево, терминал B", uri: "ymapsbm1://org?b" });

export const pinned: Partial<YandexTaxiPageResult> = { data: { available: true, entrance: "", point: fromPoint, unavailableReason: "", zone: "moscow" } };
export const zone: Partial<YandexTaxiPageResult> = {
  data: { currency: "RUB", tariffs: [{ class: "econom", id: "econom-id", name: "Эконом" }, { class: "business", id: "business", name: "Комфорт" }, { class: "vip", id: "vip", name: "Бизнес" }] },
};
export const payments: Partial<YandexTaxiPageResult> = {
  data: { cards: [{ id: "card-1", last4: "1234", system: "MIR" }], last: { id: "card-1", type: "card" }, yandexCards: [{ id: "ya-1" }] },
};
export const routeStats = (price = "350 $SIGN$", offer = "offer-1"): Partial<YandexTaxiPageResult> => ({
  data: {
    currencySign: "₽", currencyText: "", offer,
    levels: [
      { class: "econom", fixed: true, hidden: false, price, unavailable: false, waitingSeconds: 190 },
      { class: "business", fixed: false, hidden: false, price: "от 500 до 600 $SIGN$", unavailable: false, waitingSeconds: null },
      { class: "vip", fixed: true, hidden: true, price: "900 $SIGN$", unavailable: false, waitingSeconds: 60 },
    ],
  },
});

/** Everything a priced route needs, from launch to routestats. */
export const pricedRoute = (overrides: TaxiAnswers = {}): TaxiAnswers => ({
  [PATHS.finalize]: pinned, [PATHS.launch]: launchOk(), [PATHS.payments]: payments, [PATHS.routeStats]: routeStats(), [PATHS.zone]: zone, ...overrides,
});
