/**
 * Lavka client over a fake browser tab.
 *
 * Constructs covered:
 * - A tab on another site is navigated to Lavka before the first call.
 * - A lost session is `AGENT_LAVKA_AUTH_REQUIRED`, not a retry.
 * - Adding a product sends the absolute quantity under the cart's version and reports a product
 *   the store dropped.
 * - Placing an order refuses a cart whose version or total drifted since the preview.
 */
import { describe, expect, it, vi } from "vitest";

import { createLavkaClient, type LavkaDeliveryPoint } from "./lavka-client.js";

const point: LavkaDeliveryPoint = { city: "Москва", comment: "", country: "Россия", doorcode: "", entrance: "1", flat: "5", floor: "2", house: "11к1", label: "Корабельная 11к1", lat: 55.7, lon: 37.6, placeId: "", street: "Корабельная" };

type Answer = { authorized?: boolean; data: unknown; status?: number } | ((body: unknown) => { authorized?: boolean; data: unknown; status?: number });

function tab(answers: Record<string, Answer>, url = "https://lavka.yandex.ru/") {
  const calls: Array<{ body: unknown; url: string }> = [];
  const driver = {
    eval: vi.fn(async (script: string) => {
      const request = JSON.parse(/const req = (\{.*?\});\n/su.exec(script)![1]!) as { body: unknown; url: string };
      calls.push({ body: request.body, url: request.url });
      const answer = answers[request.url];
      if (!answer) throw new Error(`no answer for ${request.url}`);
      const value = typeof answer === "function" ? answer(request.body) : answer;
      return JSON.stringify({ authorized: value.authorized ?? true, data: value.data, status: value.status ?? 200 });
    }),
    open: vi.fn(async () => {}),
    settle: vi.fn(async () => {}),
    url: vi.fn(async () => url),
  };
  return { calls, client: createLavkaClient({ driver, sleep: async () => {} }), driver };
}

const cart = (version: number, items: Array<{ id: string; price: number; quantity: number }>, total: number) => ({
  availableForCheckout: true, cartId: "c1", cartVersion: version, cashbackAvailable: null, cashbackWalletId: "", checkoutBlockedReason: "", deliveryFee: 0, discount: 0, eta: "20 мин", flowVersion: "grocery_flow_v1",
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

  it("adds a product as an absolute quantity under the cart version and reports a dropped one", async () => {
    const { calls, client } = tab({
      "/api/v1/providers/cart/v1/retrieve": { data: cart(7, [{ id: "a", price: 100, quantity: 2 }], 200) },
      "/api/v1/providers/cart/v1/update": (body) => ({ data: cart(8, (body as { items: Array<{ id: string; quantity: string }> }).items.filter((i) => i.id === "a").map((i) => ({ id: i.id, price: 100, quantity: Number(i.quantity) })), 300) }),
    });
    const result = await client.addItem(point, "a", 1);
    expect(result.cartVersion).toBe(8);
    const update = calls.find((c) => c.url === "/api/v1/providers/cart/v1/update")!.body as { cartVersion: number; idempotencyToken: string; items: Array<{ id: string; price: string; quantity: string }>; position: unknown };
    expect(update.cartVersion).toBe(7);
    expect(update.items).toEqual([{ currency: "RUB", id: "a", price: "100", pricePerCount: "1", quantity: "3", quantityType: "unit", title: "" }]);
    expect(update.idempotencyToken).toMatch(/^[0-9a-f]{32}$/u);
    expect(update.position).toEqual({ location: [37.6, 55.7] });
    await expect(client.addItem(point, "b", 1)).rejects.toMatchObject({ code: "AGENT_LAVKA_ITEM_DROPPED" });
  });

  it("refuses to order a cart that drifted since the preview and submits an unchanged one once", async () => {
    const { calls, client } = tab({
      "/api/v1/orders/submit": { data: { orderId: "o-1" } },
      "/api/v1/providers/cart/v1/retrieve": { data: cart(9, [{ id: "a", price: 100, quantity: 3 }], 300) },
      "/api/v1/providers/payments/v1/status": { data: { redirectUrl: "", status: "hold" } },
      "/api/v1/providers/v2/service-info?position[location][0]=37.6&position[location][1]=55.7&fallbackCurrencySign=%E2%82%BD&depotType=regular": { data: { depotId: "d-1" } },
    });
    await expect(client.placeOrder(point, { cartVersion: 8, total: 300 })).rejects.toMatchObject({ code: "AGENT_LAVKA_CART_CHANGED" });
    await expect(client.placeOrder(point, { cartVersion: 9, total: 250 })).rejects.toMatchObject({ code: "AGENT_LAVKA_CART_CHANGED" });
    expect(calls.filter((c) => c.url === "/api/v1/orders/submit")).toHaveLength(0);

    const placed = await client.placeOrder(point, { cartVersion: 9, total: 300 });
    expect(placed).toEqual({ orderId: "o-1", paymentStatus: "hold", redirectUrl: "" });
    const submit = calls.find((c) => c.url === "/api/v1/orders/submit")!.body as { cartVersion: number; paymentMethodId: string; position: { depotId: string; flat: string } };
    expect(submit).toMatchObject({ cartVersion: 9, paymentMethodId: "card-1", position: { depotId: "d-1", flat: "5" } });
    expect(calls.filter((c) => c.url === "/api/v1/orders/submit")).toHaveLength(1);
  });
});
