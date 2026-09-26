/**
 * Yandex Lavka constants: the private web API of lavka.yandex.ru, called from inside the
 * person's own logged-in browser tab, and the limits of what the tool shows and orders.
 *
 * Every path was captured from the site's own frontend traffic (yandex-lavka-mcp, MIT,
 * 2026-07-19). Nothing here is a published API: a changed path is a named error, never a guess.
 */
export const LAVKA_ORIGIN = "https://lavka.yandex.ru";
export const LAVKA_HOST = "lavka.yandex.ru";

export const LAVKA_ENDPOINTS = {
  addresses: { method: "POST", path: "/api/v1/providers/address/v1/get-favorite-addresses" },
  cart: { method: "POST", path: "/api/v1/providers/cart/v1/retrieve" },
  cartUpdate: { method: "POST", path: "/api/v1/providers/cart/v1/update" },
  geoGeocode: { method: "POST", path: "/api/v1/providers/geo/v1/geocode" },
  geoSuggest: { method: "POST", path: "/api/v1/providers/geo/v1/suggest" },
  orderCancel: { method: "POST", path: "/api/v1/orders/{orderId}/cancel" },
  orderSubmit: { method: "POST", path: "/api/v1/orders/submit" },
  paymentMethods: { method: "POST", path: "/api/v1/providers/payments/v1/methods" },
  paymentStatus: { method: "POST", path: "/api/v1/providers/payments/v1/status" },
  product: { method: "POST", path: "/api/v1/providers/v1/product" },
  search: { method: "POST", path: "/api/v1/providers/search/v3/lavka" },
  serviceInfo: { method: "GET", path: "/api/v1/providers/v2/service-info" },
  trackedOrders: { method: "GET", path: "/api/v1/providers/orders-tracking/v1/tracked-orders" },
} as const;

export type LavkaEndpoint = keyof typeof LAVKA_ENDPOINTS;

/** Products shown per search; the site returns far more. */
export const LAVKA_SEARCH_LIMIT = 12;
/** Cart writes retried after an optimistic-concurrency conflict (another device, the app). */
export const LAVKA_CART_CONFLICT_RETRIES = 3;
/** Rubles of drift between the confirmed and the live total that still counts as the same order. */
export const LAVKA_PRICE_TOLERANCE_RUB = 0.01;
/** Payment status polls after submit, roughly a second apart. */
export const LAVKA_PAYMENT_POLL_ATTEMPTS = 6;
/** Response bytes the page hands back; projections keep real answers far below this. */
export const LAVKA_PAGE_RESULT_MAX_BYTES = 200_000;
export const LAVKA_ITEM_MAX_QUANTITY = 50;
