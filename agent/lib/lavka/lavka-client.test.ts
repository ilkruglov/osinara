/**
 * Lavka client over a fake browser tab.
 *
 * Constructs covered:
 * - A tab on another site is navigated to Lavka before the first call.
 * - A lost session is `AGENT_LAVKA_AUTH_REQUIRED`, not a retry.
 * - Adding a product sends the absolute quantity under the cart's version and reports a product
 *   the store dropped.
 * - Placing an order refuses a cart whose version, total, address or card drifted since the preview.
 * - No card is chosen for the person: without a cart card and an available default it is an error.
 * - Once the submit returned an order number, a failing payment poll keeps it; an unreadable
 *   submit answer is ambiguous, a refusal the site explained is not.
 * - A tab moved to another site mid-call is a named refusal, not an outage.
 */
import { describe, expect, it, vi } from "vitest";

import { createLavkaClient, lavkaAddressKey, type LavkaDeliveryPoint } from "./lavka-client.js";

const point: LavkaDeliveryPoint = { city: "Москва", comment: "", country: "Россия", doorcode: "", entrance: "1", flat: "5", floor: "2", house: "11к1", label: "Корабельная 11к1", lat: 55.7, lon: 37.6, placeId: "", street: "Корабельная" };

type Reply = { authorized?: boolean; data: unknown; error?: string; status?: number };
type Answer = Reply | ((body: unknown) => Reply);

function tab(answers: Record<string, Answer>, url = "https://lavka.yandex.ru/", pageError?: string) {
  const calls: Array<{ body: unknown; url: string }> = [];
  const driver = {
    eval: vi.fn(async (script: string) => {
      const request = JSON.parse(/const req = (\{.*?\});\n/su.exec(script)![1]!) as { body: unknown; url: string };
      calls.push({ body: request.body, url: request.url });
      const answer = answers[request.url];
      if (!answer) throw new Error(`no answer for ${request.url}`);
      if (pageError) return JSON.stringify({ authorized: true, data: null, error: pageError, status: 0 });
      const value = typeof answer === "function" ? answer(request.body) : answer;
      return JSON.stringify({ authorized: value.authorized ?? true, data: value.data, error: value.error ?? null, status: value.status ?? 200 });
    }),
    open: vi.fn(async () => {}),
    settle: vi.fn(async () => {}),
    url: vi.fn(async () => url),
  };
  return { calls, client: createLavkaClient({ driver, sleep: async () => {} }), driver };
}

const cart = (version: number, items: Array<{ id: string; price: number; quantity: number }>, total: number) => ({
  availableForCheckout: true, cartId: "c1", cartVersion: version, cashbackAvailable: null, cashbackWalletId: "", checkoutBlockedReason: "", deliveryFee: 0, deliveryTimeInfo: { kind: "on_demand" }, deliveryType: "eats_dispatch", discount: 0, eta: "20 мин", flowVersion: "grocery_flow_v1", nextIdempotencyToken: `tok-${version}`,
  itemCount: items.length, items: items.map((i) => ({ amount: "", id: i.id, price: i.price, quantity: i.quantity, title: i.id, unavailableOnDepot: false })), paymentMethod: { bank: "Т-Банк", id: "card-1", system: "MIR", type: "card" }, subtotal: total, total,
});

describe("createLavkaClient", () => {
  it("navigates a tab on another site to Lavka before calling", async () => {
    const { client, driver } = tab({ "/api/v1/providers/search/v3/lavka": { data: [] } }, "https://passport.yandex.ru/auth");
    await client.search("молоко", point);
    expect(driver.open).toHaveBeenCalledWith("https://lavka.yandex.ru/");
    expect(driver.settle).toHaveBeenCalled();
  });

  it("names a lost session instead of retrying", async () => {
    const { client } = tab({ "/api/v1/providers/cart/v1/retrieve": { authorized: false, data: null, status: 401 } });
    await expect(client.cart(point)).rejects.toMatchObject({ code: "AGENT_LAVKA_AUTH_REQUIRED" });
  });

  // 26 September 2026: the first live add was a 400 whose body named the wrong field; the tool said only «не ответила».
  it("repeats the site's own reason for a refused request and keeps an outage an outage", async () => {
    const { client } = tab({ "/api/v1/providers/cart/v1/retrieve": { data: null, error: JSON.stringify({ data: { errors: ["deliveryType must match the following: \"/^(eats_dispatch|courier)$/\""], name: "ValidationError" } }), status: 400 } });
    await expect(client.cart(point)).rejects.toMatchObject({ code: "AGENT_LAVKA_REJECTED", message: expect.stringContaining("deliveryType must match") });
    const outage = tab({ "/api/v1/providers/cart/v1/retrieve": { data: null, error: "<html>502</html>", status: 502 } });
    await expect(outage.client.cart(point)).rejects.toMatchObject({ code: "AGENT_LAVKA_UNAVAILABLE" });
  });

  it("adds a product as an absolute quantity under the cart version and reports a dropped one", async () => {
    const { calls, client } = tab({
      "/api/v1/providers/cart/v1/retrieve": { data: cart(7, [{ id: "a", price: 100, quantity: 2 }], 200) },
      "/api/v1/providers/cart/v1/update": (body) => ({ data: cart(8, (body as { items: Array<{ id: string; quantity: string }> }).items.filter((i) => i.id === "a").map((i) => ({ id: i.id, price: 100, quantity: Number(i.quantity) })), 300) }),
    });
    const result = await client.addItem(point, "a", 1, null);
    expect(result.cartVersion).toBe(8);
    const update = calls.find((c) => c.url === "/api/v1/providers/cart/v1/update")!.body as { cartVersion: number; deliveryTimeInfo: unknown; deliveryType: string; idempotencyToken: string; items: Array<{ id: string; price: string; quantity: string }>; position: unknown };
    expect(update.cartVersion).toBe(7);
    expect(update.items).toEqual([{ currency: "RUB", id: "a", price: "100", pricePerCount: "1", quantity: "3", quantityType: "unit", title: "" }]);
    // The site validates the write against the cart it handed out (26 September 2026: nulls were a 400).
    expect(update.idempotencyToken).toBe("tok-7");
    expect(update.deliveryType).toBe("eats_dispatch");
    expect(update.deliveryTimeInfo).toEqual({ kind: "on_demand" });
    expect(update.position).toEqual({ location: [37.6, 55.7] });
    // A new product needs its catalogue price; the store dropping it is reported.
    await expect(client.addItem(point, "b", 1, null)).rejects.toMatchObject({ code: "AGENT_LAVKA_PRICE_REQUIRED" });
    await expect(client.addItem(point, "b", 1, 113)).rejects.toMatchObject({ code: "AGENT_LAVKA_ITEM_DROPPED" });
    const priced = calls.filter((c) => c.url === "/api/v1/providers/cart/v1/update").at(-1)!.body as { items: Array<{ price: string }> };
    expect(priced.items[0]!.price).toBe("113");
  });

  it("refuses to order a cart that drifted since the preview and submits an unchanged one once", async () => {
    const { calls, client } = tab({
      "/api/v1/orders/submit": { data: { orderId: "o-1" } },
      "/api/v1/providers/cart/v1/retrieve": { data: cart(9, [{ id: "a", price: 100, quantity: 3 }], 300) },
      "/api/v1/providers/payments/v1/status": { data: { redirectUrl: "", status: "hold" } },
      "/api/v1/providers/v2/service-info?position[location][0]=37.6&position[location][1]=55.7&fallbackCurrencySign=%E2%82%BD&depotType=regular": { data: { depotId: "d-1" } },
    });
    const confirmed = { addressKey: lavkaAddressKey(point), paymentMethodId: "card-1" };
    await expect(client.placeOrder(point, { ...confirmed, cartVersion: 8, total: 300 })).rejects.toMatchObject({ code: "AGENT_LAVKA_CART_CHANGED" });
    await expect(client.placeOrder(point, { ...confirmed, cartVersion: 9, total: 250 })).rejects.toMatchObject({ code: "AGENT_LAVKA_CART_CHANGED" });
    await expect(client.placeOrder({ ...point, flat: "6" }, { ...confirmed, cartVersion: 9, total: 300 })).rejects.toMatchObject({ code: "AGENT_LAVKA_ADDRESS_CHANGED" });
    await expect(client.placeOrder(point, { ...confirmed, cartVersion: 9, paymentMethodId: "card-2", total: 300 })).rejects.toMatchObject({ code: "AGENT_LAVKA_PAYMENT_CHANGED" });
    expect(calls.filter((c) => c.url === "/api/v1/orders/submit")).toHaveLength(0);

    const placed = await client.placeOrder(point, { ...confirmed, cartVersion: 9, total: 300 });
    expect(placed).toEqual({ orderId: "o-1", paymentStatus: "hold", redirectUrl: "" });
    const submit = calls.find((c) => c.url === "/api/v1/orders/submit")!.body as { cartVersion: number; paymentMethodId: string; position: { depotId: string; flat: string } };
    expect(submit).toMatchObject({ cartVersion: 9, paymentMethodId: "card-1", position: { depotId: "d-1", flat: "5" } });
    expect(calls.filter((c) => c.url === "/api/v1/orders/submit")).toHaveLength(1);
  });

  const SERVICE = "/api/v1/providers/v2/service-info?position[location][0]=37.6&position[location][1]=55.7&fallbackCurrencySign=%E2%82%BD&depotType=regular";
  const noCardCart = { ...cart(9, [{ id: "a", price: 100, quantity: 3 }], 300), paymentMethod: null };

  it("never picks a card the person did not choose", async () => {
    const { client } = tab({
      "/api/v1/providers/cart/v1/retrieve": { data: noCardCart },
      "/api/v1/providers/payments/v1/methods": { data: { defaultId: "card-default", methods: [{ available: false, bank: "", id: "card-default", label: "", type: "card" }, { available: true, bank: "", id: "card-other", label: "", type: "card" }] } },
    });
    await expect(client.checkoutPreview(point)).resolves.toMatchObject({ addressKey: lavkaAddressKey(point), paymentChoice: null, paymentMethodId: null });
    await expect(client.placeOrder(point, { addressKey: lavkaAddressKey(point), cartVersion: 9, paymentMethodId: "card-other", total: 300 })).rejects.toMatchObject({ code: "AGENT_LAVKA_PAYMENT_MISSING" });
  });

  it("keeps the order number when the payment poll fails and calls an unreadable submit ambiguous", async () => {
    const confirmed = { addressKey: lavkaAddressKey(point), cartVersion: 9, paymentMethodId: "card-1", total: 300 };
    const base = { "/api/v1/providers/cart/v1/retrieve": { data: cart(9, [{ id: "a", price: 100, quantity: 3 }], 300) }, [SERVICE]: { data: { depotId: "d-1" } } };
    const pollDown = tab({ ...base, "/api/v1/orders/submit": { data: { orderId: "o-7" } }, "/api/v1/providers/payments/v1/status": { data: null, error: "<html>502</html>", status: 502 } });
    await expect(pollDown.client.placeOrder(point, confirmed)).resolves.toEqual({ orderId: "o-7", paymentStatus: "unknown", redirectUrl: "" });
    const lost = tab({ ...base, "/api/v1/orders/submit": { data: null, error: "<html>504</html>", status: 504 } });
    await expect(lost.client.placeOrder(point, confirmed)).rejects.toMatchObject({ code: "AGENT_LAVKA_ORDER_AMBIGUOUS" });
    const empty = tab({ ...base, "/api/v1/orders/submit": { data: { orderId: "" } } });
    await expect(empty.client.placeOrder(point, confirmed)).rejects.toMatchObject({ code: "AGENT_LAVKA_ORDER_AMBIGUOUS" });
    const refused = tab({ ...base, "/api/v1/orders/submit": { data: null, error: JSON.stringify({ data: { message: "Корзина пуста" } }), status: 400 } });
    await expect(refused.client.placeOrder(point, confirmed)).rejects.toMatchObject({ code: "AGENT_LAVKA_REJECTED" });
  });

  it("names a tab that moved to another site during the call", async () => {
    const { client } = tab({ "/api/v1/providers/cart/v1/retrieve": { data: null } }, "https://lavka.yandex.ru/", "wrong_origin:evil.example");
    await expect(client.cart(point)).rejects.toMatchObject({ code: "AGENT_LAVKA_TAB_MOVED" });
  });
});
