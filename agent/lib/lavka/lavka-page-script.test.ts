/**
 * The in-page Lavka script, executed in Node against a fake tab.
 *
 * Constructs covered:
 * - The request goes to the site's own path with the CSRF token from the page and the session
 *   cookies (`credentials: include`); the person's text reaches the page only as a JSON literal.
 * - Big answers are projected in the page: a search keeps a dozen trimmed products, a cart keeps
 *   ids, versions, items and totals.
 * - 401/403 come back as `authorized: false`, a non-JSON body as `data: null`.
 */
import { describe, expect, it, vi } from "vitest";

import type { LavkaPageRequest } from "./lavka-page-script.js";
import { lavkaPageScript } from "./lavka-page-script.js";

function runInFakeTab(request: LavkaPageRequest, response: { body: unknown; status: number }, searchLimit = 12) {
  const fetch = vi.fn(async () => ({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    text: async () => typeof response.body === "string" ? response.body : JSON.stringify(response.body),
  }));
  const document = { documentElement: { innerHTML: "<script>{\"csrfToken\":\"tok-1\"}</script>" } };
  // oxlint-disable-next-line typescript/no-implied-eval -- the fixed page script runs against a fake tab
  const run = new Function("fetch", "document", `return ${lavkaPageScript(request, searchLimit)};`) as (f: unknown, d: unknown) => Promise<string>;
  return { fetch, result: run(fetch, document).then((text) => JSON.parse(text) as { authorized: boolean; data: unknown; status: number }) };
}

describe("lavkaPageScript", () => {
  it("posts to the site's path with the page's CSRF token and the session cookies", async () => {
    const { fetch, result } = runInFakeTab({ body: { text: "молоко 'х'" }, endpoint: "search", project: "search" }, { body: { cacheProducts: [] }, status: 200 });
    expect(await result).toEqual({ authorized: true, data: [], status: 200 });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { body: string; credentials: string; headers: Record<string, string>; method: string }];
    expect(url).toBe("/api/v1/providers/search/v3/lavka");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(init.headers["x-csrf-token"]).toBe("tok-1");
    expect(init.headers["x-lavka-web-city"]).toBe("213");
    expect(JSON.parse(init.body)).toEqual({ text: "молоко 'х'" });
  });

  it("projects a search and a cart down to what the tool shows", async () => {
    const products = Array.from({ length: 30 }, (_, i) => ({ available: i % 2 === 0, currentPrice: `${100 + i}`, deepLink: `slug-${i}`, id: `hash-${i}`, oldPrice: null, title: `Товар ${i}`, amount: "1 л", huge: "x".repeat(10_000) }));
    const search = await runInFakeTab({ endpoint: "search", project: "search" }, { body: { cacheProducts: products }, status: 200 }, 3).result;
    expect(search.data).toEqual([
      { amount: "1 л", available: true, id: "hash-0", oldPrice: null, price: 100, slug: "slug-0", title: "Товар 0" },
      { amount: "1 л", available: false, id: "hash-1", oldPrice: null, price: 101, slug: "slug-1", title: "Товар 1" },
      { amount: "1 л", available: true, id: "hash-2", oldPrice: null, price: 102, slug: "slug-2", title: "Товар 2" },
    ]);

    const cart = await runInFakeTab({ endpoint: "cart", project: "cart" }, { body: { cart: {
      availableForCheckout: true, cartId: "c1", cartVersion: 7, items: [{ id: "hash-0", title: "Товар 0", quantity: "2", currentPrice: "100", amount: "1 л", isUnavailableOnDepot: false }],
      orderConditions: { deliveryCost: "199", eta: "15–25 мин" }, paymentMethod: { id: "card-1", type: "card", meta: { card: { system: "MIR", cardBank: "Т-Банк" } } },
      totalDiscountValue: "0", totalItemsCount: 2, totalItemsPrice: "200", totalPriceValue: "399",
    } }, status: 200 }).result;
    expect(cart.data).toMatchObject({ availableForCheckout: true, cartId: "c1", cartVersion: 7, deliveryFee: 199, eta: "15–25 мин", itemCount: 2, subtotal: 200, total: 399 });
    expect((cart.data as { items: unknown[] }).items).toEqual([{ amount: "1 л", id: "hash-0", price: 100, quantity: 2, title: "Товар 0", unavailableOnDepot: false }]);
    expect((cart.data as { paymentMethod: unknown }).paymentMethod).toEqual({ bank: "Т-Банк", id: "card-1", system: "MIR", type: "card" });
  });

  it("reports a lost session and an unreadable answer without guessing", async () => {
    expect(await runInFakeTab({ endpoint: "cart", project: "cart" }, { body: "<html>login</html>", status: 401 }).result).toEqual({ authorized: false, data: null, status: 401 });
    expect(await runInFakeTab({ endpoint: "cart", project: "cart" }, { body: "<html>captcha</html>", status: 200 }).result).toEqual({ authorized: true, data: null, status: 200 });
  });

  it("fills a per-order path and encodes the query of a GET", () => {
    expect(lavkaPageScript({ body: {}, endpoint: "orderCancel", orderId: "o/1", project: "raw" }, 12)).toContain("\"url\":\"/api/v1/orders/o%2F1/cancel\"");
    expect(lavkaPageScript({ endpoint: "serviceInfo", project: "serviceInfo", query: "a=1" }, 12)).toContain("\"url\":\"/api/v1/providers/v2/service-info?a=1\"");
  });
});
