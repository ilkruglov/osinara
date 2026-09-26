/**
 * Yandex Lavka through the person's own browser tab.
 *
 * Exports:
 * - `createLavkaClient`: catalogue, cart, addresses, checkout preview and order placement, each
 *   one `agent-browser eval` of `lavka-page-script.ts` in the sandbox's Chromium.
 * - `LavkaDeliveryPoint`: where the order goes; chosen once, kept by the repository.
 * - `LavkaCart`, `LavkaProduct`, `LavkaAddress`, `LavkaOrderPlacement`: the shapes the tool shows.
 *
 * Key constructs:
 * - No cookies leave the browser: the tab is logged into Yandex (through `browser_*`), and the
 *   site's own `fetch` carries the session. A tab on another site is navigated to Lavka first.
 * - The cart is one server-side resource per account under optimistic concurrency (`cartVersion`):
 *   every write re-reads the cart and retries a conflict a few times.
 * - Placing an order re-reads the cart and refuses when the version or the total drifted from what
 *   the person confirmed; the submit is never retried (a lost answer could mean two orders).
 * - Not a published API: an unexpected answer is `AGENT_LAVKA_UNAVAILABLE`, never a guess.
 */
import { randomUUID } from "node:crypto";

import { AppError } from "../app-error.js";
import type { BrowserDriver } from "../browser/browser-driver.js";
import {
  LAVKA_CART_CONFLICT_RETRIES,
  LAVKA_HOST,
  LAVKA_ORIGIN,
  LAVKA_PAYMENT_POLL_ATTEMPTS,
  LAVKA_PRICE_TOLERANCE_RUB,
  LAVKA_SEARCH_LIMIT,
} from "./lavka-config.js";
import type { LavkaPageRequest, LavkaPageResult } from "./lavka-page-script.js";
import { lavkaPageScript } from "./lavka-page-script.js";

export interface LavkaDeliveryPoint {
  city: string; comment: string; country: string; doorcode: string; entrance: string; flat: string; floor: string;
  house: string; label: string; lat: number; lon: number; placeId: string; street: string;
}
export interface LavkaProduct { amount: string; available: boolean; id: string; oldPrice: number | null; price: number | null; slug: string; title: string; }
export interface LavkaProductDetails extends LavkaProduct { brand: string; description: string; }
export interface LavkaCartItem { amount: string; id: string; price: number | null; quantity: number; title: string; unavailableOnDepot: boolean; }
export interface LavkaCart {
  availableForCheckout: boolean | null; cartId: string; cartVersion: number | null; cashbackAvailable: number | null; cashbackWalletId: string;
  checkoutBlockedReason: string; deliveryFee: number | null; deliveryTimeInfo: unknown; deliveryType: string; discount: number; eta: string; flowVersion: string; itemCount: number;
  /** The token the site expects on the next write; a cart write without the cart's own values is a 400. */
  nextIdempotencyToken: string;
  items: LavkaCartItem[]; paymentMethod: { bank: string; id: string; system: string; type: string } | null; subtotal: number | null; total: number | null;
}
export interface LavkaAddress extends LavkaDeliveryPoint { addressId: string; fullAddress: string; }
export interface LavkaPaymentMethod { available: boolean; bank: string; id: string; label: string; type: string; }
export interface LavkaOrderPlacement { orderId: string; paymentStatus: string; redirectUrl: string; }

interface Deps { driver: Pick<BrowserDriver, "eval" | "open" | "settle" | "url">; sleep?: (ms: number) => Promise<void>; }

const unavailable = (diagnostic: string): AppError => {
  console.error(JSON.stringify({ code: "AGENT_LAVKA_UNAVAILABLE", diagnostic }));
  return new AppError("AGENT_LAVKA_UNAVAILABLE", "Лавка не ответила или ответила непонятно. Попробуйте позже");
};

export function createLavkaClient(deps: Deps) {
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  async function ensureTab(): Promise<void> {
    let host = "";
    try { host = new URL(await deps.driver.url()).hostname; } catch { host = ""; }
    if (host === LAVKA_HOST) return;
    await deps.driver.open(`${LAVKA_ORIGIN}/`);
    await deps.driver.settle();
  }

  async function call<T>(request: LavkaPageRequest): Promise<{ data: T; status: number }> {
    await ensureTab();
    const raw = await deps.driver.eval(lavkaPageScript(request, LAVKA_SEARCH_LIMIT));
    let result: LavkaPageResult;
    try { result = JSON.parse(raw) as LavkaPageResult; } catch { throw unavailable("page_result_not_json"); }
    if (!result.authorized) {
      throw new AppError("AGENT_LAVKA_AUTH_REQUIRED", "Лавка не узнаёт вход: нужно войти в Яндекс в браузере Мии (browser_open https://passport.yandex.ru/auth), потом повторить");
    }
    return { data: result.data as T, status: result.status };
  }

  async function ok<T>(request: LavkaPageRequest): Promise<T> {
    const { data, status } = await call<T | null>(request);
    if (status === 409) throw new AppError("AGENT_LAVKA_CART_CONFLICT", "Корзина изменилась с другого устройства, повторите действие");
    if (status === 429) throw new AppError("AGENT_LAVKA_RATE_LIMITED", "Лавка временно ограничила число запросов. Попробуйте позже");
    if (status >= 400 || data === null) throw unavailable(`status_${status}`);
    return data;
  }

  const position = (point: LavkaDeliveryPoint | null) => point ? { position: { location: [point.lon, point.lat] } } : {};
  const baseBody = (point: LavkaDeliveryPoint | null) => ({ additionalData: {}, currencySign: "₽", depotType: "regular", ...position(point) });

  async function cart(point: LavkaDeliveryPoint | null): Promise<LavkaCart> {
    return await ok<LavkaCart>({ body: baseBody(point), endpoint: "cart", project: "cart" });
  }

  const itemBody = (id: string, quantity: number, price: number | null) => ({ currency: "RUB", id, price: price === null ? "" : String(price), pricePerCount: "1", quantity: String(quantity), quantityType: "unit", title: "" });

  /**
   * Read-modify-write under `cartVersion`; `build` returns absolute quantities from the fresh cart.
   * The site validates every write against the cart it just handed out: delivery type and time
   * info, the next idempotency token and a numeric price per item (the cart's own for a product
   * already there, the catalogue price for a new one). Learned live on 26 September 2026: the
   * upstream capture sent nulls and the update was a 400.
   */
  async function mutate(point: LavkaDeliveryPoint | null, build: (current: LavkaCart) => Array<{ id: string; price?: number | null; quantity: number }>): Promise<LavkaCart> {
    for (let attempt = 0; ; attempt += 1) {
      const current = await cart(point);
      const items = build(current).map((item) => itemBody(item.id, item.quantity, current.items.find((i) => i.id === item.id)?.price ?? item.price ?? null));
      if (items.length === 0) return current;
      if (items.some((item) => item.price === "")) throw new AppError("AGENT_LAVKA_PRICE_REQUIRED", "Для нового товара в корзине нужна его цена из выдачи search (поле price)");
      const body = {
        ...baseBody(point), cartId: current.cartId, cartVersion: current.cartVersion, deliveryTimeInfo: current.deliveryTimeInfo, deliveryType: current.deliveryType,
        idempotencyToken: current.nextIdempotencyToken || randomUUID().replace(/-/gu, ""), isUserOrderEdit: false, items,
      };
      try {
        return await ok<LavkaCart>({ body, endpoint: "cartUpdate", project: "cart" });
      } catch (error) {
        if (error instanceof AppError && error.code === "AGENT_LAVKA_CART_CONFLICT" && attempt < LAVKA_CART_CONFLICT_RETRIES) { await sleep(500 * (attempt + 1)); continue; }
        throw error;
      }
    }
  }

  return {
    async addItem(point: LavkaDeliveryPoint | null, id: string, quantity: number, price: number | null): Promise<LavkaCart> {
      const result = await mutate(point, (current) => [{ id, price, quantity: (current.items.find((i) => i.id === id)?.quantity ?? 0) + quantity }]);
      // The site silently drops a product the current store cannot sell; the tool must say so.
      if (!result.items.some((i) => i.id === id)) throw new AppError("AGENT_LAVKA_ITEM_DROPPED", "Лавка не положила товар в корзину: в этом магазине его нет. Выберите другой");
      return result;
    },
    cancelOrder: async (orderId: string) => { await ok<unknown>({ body: {}, endpoint: "orderCancel", orderId, project: "raw" }); return { cancelled: true, orderId }; },
    cart,
    async checkoutPreview(point: LavkaDeliveryPoint | null): Promise<LavkaCart & { paymentChoice: LavkaPaymentMethod | null }> {
      const current = await cart(point);
      return { ...current, paymentChoice: await resolvePayment(current, point) };
    },
    clearCart: (point: LavkaDeliveryPoint | null) => mutate(point, (current) => current.items.map((i) => ({ id: i.id, quantity: 0 }))),
    addresses: () => ok<LavkaAddress[]>({ body: {}, endpoint: "addresses", project: "addresses" }),
    paymentMethods,
    paymentStatus: (orderId: string) => ok<{ redirectUrl: string; status: string }>({ body: { orderId, paymentType: "card" }, endpoint: "paymentStatus", project: "payment" }),
    async placeOrder(point: LavkaDeliveryPoint, expected: { cartVersion: number; total: number }): Promise<LavkaOrderPlacement> {
      const live = await cart(point);
      if (live.cartVersion !== expected.cartVersion) throw new AppError("AGENT_LAVKA_CART_CHANGED", `Корзина изменилась после предпросмотра (версия ${expected.cartVersion} → ${live.cartVersion}). Покажите новый предпросмотр и подтвердите заново`);
      if (live.total === null || Math.abs(live.total - expected.total) > LAVKA_PRICE_TOLERANCE_RUB) throw new AppError("AGENT_LAVKA_CART_CHANGED", `Сумма изменилась после подтверждения (${expected.total} → ${live.total}). Покажите новый предпросмотр и подтвердите заново`);
      if (live.availableForCheckout === false) throw new AppError("AGENT_LAVKA_CHECKOUT_BLOCKED", `Лавка не принимает эту корзину${live.checkoutBlockedReason ? ` (${live.checkoutBlockedReason})` : ""}. Уберите недоступные позиции и повторите предпросмотр`);
      const payment = await resolvePayment(live, point);
      if (!payment) throw new AppError("AGENT_LAVKA_PAYMENT_MISSING", "У аккаунта Лавки нет доступной карты. Добавьте карту в приложении Лавки");
      const service = await ok<{ depotId: string }>({ endpoint: "serviceInfo", project: "serviceInfo", query: `position[location][0]=${point.lon}&position[location][1]=${point.lat}&fallbackCurrencySign=%E2%82%BD&depotType=regular` });
      const body = {
        cartId: live.cartId, cartVersion: live.cartVersion, cashback: live.cashbackWalletId ? { walletId: live.cashbackWalletId } : {},
        depotOrderContext: { depotType: "regular", position: [point.lon, point.lat] }, flowVersion: live.flowVersion || "grocery_flow_v1",
        paymentMethodId: payment.id, paymentMethodType: payment.type || "card",
        position: { buildingName: "", city: point.city, comment: point.comment, country: point.country || "Россия", depotId: service.depotId, doorbellName: "", doorcode: point.doorcode, entrance: point.entrance, flat: point.flat, floor: point.floor, house: point.house, leftAtDoor: false, location: [point.lon, point.lat], meetOutside: false, noDoorCall: false, placeId: point.placeId, street: point.street },
        useRover: false,
      };
      const submitted = await ok<{ orderId: string }>({ body, endpoint: "orderSubmit", project: "submit" });
      if (!submitted.orderId) throw new AppError("AGENT_LAVKA_ORDER_AMBIGUOUS", "Лавка не вернула номер заказа. Проверьте заказы в приложении Лавки, прежде чем повторять");
      let status = ""; let redirectUrl = "";
      for (let attempt = 0; attempt < LAVKA_PAYMENT_POLL_ATTEMPTS; attempt += 1) {
        const payment = await ok<{ redirectUrl: string; status: string }>({ body: { orderId: submitted.orderId, paymentType: "card" }, endpoint: "paymentStatus", project: "payment" });
        status = payment.status; redirectUrl = payment.redirectUrl;
        if (["failed", "hold", "paid", "rejected", "success", "wait_user_action"].includes(status)) break;
        await sleep(1000);
      }
      return { orderId: submitted.orderId, paymentStatus: status, redirectUrl };
    },
    product: (slug: string) => ok<LavkaProductDetails>({ body: { ...baseBody(null), enableUnavailable: true, isEcomboReward: false, needCatalogPaths: true, productId: slug, rewardPriceTemplate: "" }, endpoint: "product", project: "product" }),
    async resolveAddress(text: string, near: LavkaDeliveryPoint | null): Promise<LavkaDeliveryPoint> {
      const suggestions = await ok<Array<{ lat: number | null; lon: number | null; text: string; uri: string }>>({ body: { action: "user_input", lang: "ru", query: text, ...(near ? { location: { lat: near.lat, lon: near.lon } } : {}) }, endpoint: "geoSuggest", project: "suggest" });
      const first = suggestions.find((s) => s.lat !== null && s.lon !== null);
      if (!first) throw new AppError("AGENT_LAVKA_ADDRESS_NOT_FOUND", `Лавка не нашла адрес «${text.slice(0, 100)}»`);
      const g = await ok<{ city: string; country: string; entrance: string; house: string; lat: number | null; lon: number | null; placeId: string; street: string; text: string }>({ body: { action: "pin_drop", lang: "ru", point: { lat: first.lat, lon: first.lon }, suppressError: true }, endpoint: "geoGeocode", project: "geocode" });
      return { city: g.city, comment: "", country: g.country, doorcode: "", entrance: g.entrance, flat: "", floor: "", house: g.house, label: g.text || first.text, lat: g.lat ?? first.lat!, lon: g.lon ?? first.lon!, placeId: g.placeId || first.uri, street: g.street };
    },
    search: (query: string, point: LavkaDeliveryPoint | null) => ok<LavkaProduct[]>({ body: { ...baseBody(point), productsLimit: LAVKA_SEARCH_LIMIT, source: "manual_input", subcategoriesLimit: 0, text: query, useRetail: true }, endpoint: "search", project: "search" }),
    setItem: (point: LavkaDeliveryPoint | null, id: string, quantity: number, price: number | null) => mutate(point, () => [{ id, price, quantity }]),
    trackedOrders: () => ok<Array<{ eta: string; orderId: string; status: string; title: string }>>({ endpoint: "trackedOrders", project: "orders" }),
  };

  async function paymentMethods(point: LavkaDeliveryPoint | null): Promise<{ defaultId: string; methods: LavkaPaymentMethod[] }> {
    return await ok({ body: { countryIso3: "RUS", location: point ? [point.lon, point.lat] : [] }, endpoint: "paymentMethods", project: "paymentMethods" });
  }

  /** The card that will be charged: what the cart holds, else the account default, else the first available. */
  async function resolvePayment(current: LavkaCart, point: LavkaDeliveryPoint | null): Promise<LavkaPaymentMethod | null> {
    if (current.paymentMethod?.id) return { available: true, bank: current.paymentMethod.bank, id: current.paymentMethod.id, label: [current.paymentMethod.system, current.paymentMethod.bank].filter(Boolean).join(" "), type: current.paymentMethod.type || "card" };
    const { defaultId, methods } = await paymentMethods(point);
    return methods.find((m) => m.id === defaultId && m.available) ?? methods.find((m) => m.available) ?? null;
  }
}

export type LavkaClient = ReturnType<typeof createLavkaClient>;
