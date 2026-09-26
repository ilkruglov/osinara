/**
 * The script that runs inside the person's Lavka tab and calls the site's private API there.
 *
 * Exports:
 * - `lavkaPageScript`: one call as a self-contained async expression for `agent-browser eval`.
 * - `LavkaPageRequest`, `LavkaPageResult`: what goes in and what comes back (JSON text).
 *
 * Key constructs:
 * - The tab is logged in, so `fetch` carries the session cookies itself; nothing about the account
 *   leaves the browser, and the request looks exactly like the site's own (same origin, same
 *   headers, CSRF token read from the page).
 * - The page projects big answers (a search is hundreds of kilobytes) down to the fields the tool
 *   shows, so the CLI transport stays small. Projections are plain JS in template strings and are
 *   executed by tests in Node against a fake `fetch`.
 */
import type { LavkaEndpoint } from "./lavka-config.js";
import { LAVKA_ENDPOINTS, LAVKA_PAGE_RESULT_MAX_BYTES } from "./lavka-config.js";

export type LavkaProjection = "addresses" | "cart" | "geocode" | "orders" | "payment" | "paymentMethods" | "product" | "raw" | "search" | "serviceInfo" | "submit" | "suggest";

export interface LavkaPageRequest {
  body?: unknown;
  city?: string;
  endpoint: LavkaEndpoint;
  /** Fills `{orderId}` in a per-order path. */
  orderId?: string;
  /** Query string for GET endpoints, already encoded. */
  query?: string;
  project: LavkaProjection;
}

export interface LavkaPageResult {
  authorized: boolean;
  data: unknown;
  /** The site's answer to a refused request (a validation error names the wrong fields). */
  error?: string | null;
  status: number;
}

/** In-page projections: each takes the parsed JSON body and returns the small shape. */
const PROJECTIONS = `
const num = (v) => { if (v === null || v === undefined || typeof v === "boolean") return null; if (typeof v === "number") return v; const n = Number(String(v).replace(/\\s|\\u00a0/g, "").replace(",", ".")); return Number.isFinite(n) ? n : null; };
const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] !== null && o[k] !== undefined) return o[k]; return null; };
const str = (v, max) => typeof v === "string" ? v.slice(0, max) : v === null || v === undefined ? "" : String(v).slice(0, max);
const product = (p) => ({ id: str(pick(p, "id", "product_id"), 120), slug: str(pick(p, "deepLink", "slug", "productId"), 200), title: str(pick(p, "title", "name"), 200), price: num(pick(p, "currentPrice", "price", "pricePerItem")), oldPrice: num(pick(p, "oldPrice", "old_price")), amount: str(pick(p, "amount", "quantity", "weight"), 40), available: pick(p, "available", "in_stock", "inStock") !== false });
const cartItem = (i) => ({ id: str(pick(i, "id", "product_id"), 120), title: str(pick(i, "title", "name"), 200), quantity: num(pick(i, "quantity", "count", "qty")) ?? 1, price: num(pick(i, "currentPrice", "price")), amount: str(pick(i, "amount", "weight"), 40), unavailableOnDepot: pick(i, "isUnavailableOnDepot") === true });
const cart = (raw) => { const d = raw && raw.cart ? raw.cart : raw || {}; const items = Array.isArray(d.items) ? d.items.filter((i) => i && typeof i === "object") : []; const oc = d.orderConditions && typeof d.orderConditions === "object" ? d.orderConditions : {}; const pm = d.paymentMethod && typeof d.paymentMethod === "object" ? d.paymentMethod : null; const cb = d.cashback && typeof d.cashback === "object" ? d.cashback : {}; return { cartId: str(pick(d, "cartId"), 120), cartVersion: num(pick(d, "cartVersion")), deliveryType: str(pick(d, "deliveryType"), 40), deliveryTimeInfo: d.deliveryTimeInfo && typeof d.deliveryTimeInfo === "object" ? d.deliveryTimeInfo : null, nextIdempotencyToken: str(pick(d, "nextIdempotencyToken"), 120), items: items.map(cartItem), itemCount: num(pick(d, "totalItemsCount")) ?? items.length, subtotal: num(pick(d, "totalItemsPrice", "totalItemsPriceValue")), total: num(pick(d, "totalPriceValue", "totalPrice")), discount: num(pick(d, "totalDiscountValue")) ?? 0, deliveryFee: num(pick(oc, "deliveryCost", "fullDeliveryCost")), eta: str(pick(oc, "eta"), 60), availableForCheckout: pick(d, "availableForCheckout"), checkoutBlockedReason: str(pick(d, "checkoutUnavailableReason"), 200), flowVersion: str(pick(d, "orderFlowVersion"), 60), paymentMethod: pm ? { id: str(pick(pm, "id"), 120), type: str(pick(pm, "type"), 40), system: str(pick(pm.meta && pm.meta.card, "system"), 40), bank: str(pick(pm.meta && pm.meta.card, "cardBank"), 60) } : null, cashbackWalletId: str(pick(cb, "walletId"), 120), cashbackAvailable: num(pick(cb, "availableForPayment")) }; };
const address = (a) => { const ad = a && a.address ? a.address : {}; const loc = Array.isArray(ad.location) ? ad.location : []; return { addressId: str(pick(a, "addressId"), 120), label: str(pick(ad, "label", "shortAddress", "fullAddress"), 200), city: str(pick(ad, "city"), 100), street: str(pick(ad, "street"), 200), house: str(pick(ad, "house"), 40), flat: str(pick(ad, "flat"), 40), entrance: str(pick(ad, "entrance"), 40), floor: str(pick(ad, "floor"), 40), comment: str(pick(ad, "comment"), 300), doorcode: str(pick(ad, "doorcode"), 40), fullAddress: str(pick(ad, "fullAddress", "shortAddress"), 300), placeId: str(pick(ad, "placeId", "uri"), 300), country: str(pick(ad, "country"), 100), lon: num(loc[0]), lat: num(loc[1]) }; };
const projections = {
  raw: (raw) => raw,
  search: (raw) => { const list = raw && Array.isArray(raw.cacheProducts) ? raw.cacheProducts : []; return list.filter((p) => p && typeof p === "object").slice(0, LIMIT).map(product); },
  product: (raw) => { const p = raw && raw.product && typeof raw.product === "object" ? raw.product : {}; return Object.assign(product(p), { description: str(pick(p, "description", "longTitle"), 1500), brand: str(pick(p, "brand"), 100) }); },
  cart,
  addresses: (raw) => { const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : []; return list.filter((a) => a && typeof a === "object").slice(0, 20).map(address); },
  suggest: (raw) => { const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? (Object.values(raw).find(Array.isArray) || []) : []; return list.filter((s) => s && typeof s === "object" && Array.isArray(s.position)).slice(0, 5).map((s) => ({ lon: num(s.position[0]), lat: num(s.position[1]), text: str(pick(s, "full", "label", "title", "text"), 300), uri: str(pick(s, "uri"), 300) })); },
  geocode: (raw) => { const g = raw && typeof raw === "object" ? raw : {}; return { lat: num(pick(g, "lat")), lon: num(pick(g, "lon")), city: str(pick(g, "city"), 100), street: str(pick(g, "street"), 200), house: str(pick(g, "house"), 40), entrance: str(pick(g, "entrance"), 40), country: str(pick(g, "country"), 100), placeId: str(pick(g, "uri"), 300), text: str(pick(g, "text"), 300) }; },
  paymentMethods: (raw) => { const r = raw && typeof raw === "object" ? raw : {}; const method = (m) => ({ id: str(pick(m, "id"), 120), type: str(pick(m, "type"), 40), label: Array.isArray(m.displayName) ? m.displayName.join(" ").slice(0, 100) : str(pick(m, "displayName", "name"), 100), bank: str(pick(m, "cardBank"), 60), available: !(m.availability && m.availability.available === false) }); const def = r.defaultMethod && typeof r.defaultMethod === "object" ? method(r.defaultMethod) : null; const all = (Array.isArray(r.methods) ? r.methods : []).filter((m) => m && typeof m === "object").map(method); /* an account carries hundreds of cards; the default comes first so the cut never loses it */ const rest = all.filter((m) => !def || m.id !== def.id); return { defaultId: def ? def.id : "", methods: (def ? [def, ...rest] : rest).slice(0, 10) }; },
  serviceInfo: (raw) => ({ depotId: str(pick(raw || {}, "depotId"), 120) }),
  submit: (raw) => { const d = raw && raw.data && typeof raw.data === "object" ? raw.data : raw || {}; return { orderId: str(pick(d, "orderId", "order_id", "id"), 120) }; },
  payment: (raw) => { const d = raw && typeof raw === "object" ? raw : {}; const p = d.payload && typeof d.payload === "object" ? d.payload : {}; return { status: str(pick(d, "status"), 60), redirectUrl: str(pick(p, "redirectUrl"), 1000) }; },
  orders: (raw) => { const list = raw && Array.isArray(raw.orders) ? raw.orders : Array.isArray(raw) ? raw : []; return list.filter((o) => o && typeof o === "object").slice(0, 10).map((o) => ({ orderId: str(pick(o, "orderId", "order_id", "id", "shortOrderId"), 120), status: str(pick(o, "status", "state"), 60), eta: str(pick(o, "eta", "etaMinutes"), 40), title: str(pick(o, "title", "statusTitle"), 200) })); },
};
`;

export function lavkaPageScript(request: LavkaPageRequest, searchLimit: number): string {
  const spec = LAVKA_ENDPOINTS[request.endpoint];
  const path = request.orderId === undefined ? spec.path : spec.path.replace("{orderId}", encodeURIComponent(request.orderId));
  const url = spec.method === "GET" && request.query ? `${path}?${request.query}` : path;
  // Everything the model or the person typed reaches the page only as JSON literals.
  const literal = JSON.stringify({ body: request.body ?? null, city: request.city ?? "213", method: spec.method, project: request.project, url });
  return `(async () => {
const req = ${literal};
const LIMIT = ${Math.max(1, Math.floor(searchLimit))};
${PROJECTIONS}
const html = document.documentElement.innerHTML;
const csrf = (html.match(/"csrfToken"\\s*:\\s*"([^"]+)"/) || [])[1] || "";
const headers = { accept: "application/json", "x-requested-with": "XMLHttpRequest", "x-lavka-web-locale": "ru-RU", "x-lavka-web-city": req.city, "x-captcha-service": "lavka", "x-captcha-language": "ru" };
if (csrf) headers["x-csrf-token"] = csrf;
if (req.method !== "GET") headers["content-type"] = "application/json";
const response = await fetch(req.url, { method: req.method, credentials: "include", headers, body: req.method === "GET" ? undefined : JSON.stringify(req.body) });
const text = await response.text();
let data = null;
try { data = JSON.parse(text); } catch (error) { data = null; }
const out = { authorized: response.status !== 401 && response.status !== 403, status: response.status, data: response.ok && data !== null ? projections[req.project](data) : null, error: response.ok ? null : text.slice(0, 500) };
return JSON.stringify(out).slice(0, ${LAVKA_PAGE_RESULT_MAX_BYTES});
})()`;
}
