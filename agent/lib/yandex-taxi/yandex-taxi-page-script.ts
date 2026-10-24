/**
 * The script that runs inside the person's taxi.yandex.ru tab and calls the site's private API.
 *
 * Exports:
 * - `yandexTaxiPageScript`: one call as a self-contained async expression for `agent-browser eval`.
 * - `YandexTaxiPageRequest`, `YandexTaxiPageResult`: what goes in and what comes back (JSON text).
 *
 * Key constructs:
 * - The API lives on ya-authproxy.taxi.yandex.ru: a CORS `fetch` with `credentials: "include"`
 *   from the taxi.yandex.ru page, with the headers the site itself sends (X-Taxi, X-Request-Id,
 *   X-Requested-With, x-retpath-y, X-YaTaxi-UserId, X-Personal-Phone-Id). Cookies never leave the
 *   browser.
 * - CSRF as the site does it: the token cached by the site in localStorage, else POST /csrf_token;
 *   a refusal with INVALID_CSRF_TOKEN is retried once with a fresh token (the server rejected the
 *   request before reading it, so even an order is not sent twice).
 * - A 401 refreshes the Passport session (GET passport.yandex.ru/auth/update/) and repeats once, as
 *   the site's transport does; a second 401 is reported.
 * - A 2xx answer `{type: "captcha"}` is the antirobot page: reported as `captcha`, never solved.
 * - Projections keep only the fields the tool uses and refuse an answer without a required one
 *   (`shape:<field>`); unknown extra fields are ignored. Executed in tests against a fake `fetch`.
 * - `launch` sends the user id the site keeps in IndexedDB when there is one, like the site does;
 *   the database is opened without creating it, so the site's own schema upgrade stays intact.
 * - Every request has its own deadline and the whole call settles within
 *   `YANDEX_TAXI_PAGE_DEADLINE_MS`: an eval that never settles blocks the person's browser daemon.
 *   At the deadline every request of the call is aborted and no request starts any more, so nothing
 *   is sent after the tool has reported (Codex review, 24 October 2026).
 * - A call that did not settle reports `stage` and `sent`: whether a request the server may have
 *   acted on was out. A refusal the server gives before reading (INVALID_CSRF_TOKEN, 401) clears it
 *   before the repeat, so an order that never left the tab is not mistaken for one that may have.
 * - The site's error code is passed on only when it looks like a code (`[A-Za-z][A-Za-z0-9_.-]*`):
 *   a text in that field (an address, a name) must not reach the logs (Codex review, 24 October 2026).
 */
import {
  YANDEX_TAXI_API_HOST,
  YANDEX_TAXI_CARD_LIMIT,
  YANDEX_TAXI_ENDPOINTS,
  YANDEX_TAXI_FETCH_TIMEOUT_MS,
  YANDEX_TAXI_HOST,
  YANDEX_TAXI_PAGE_DEADLINE_MS,
  YANDEX_TAXI_PAGE_RESULT_MAX_BYTES,
  YANDEX_TAXI_PLACES_LIMIT,
  YANDEX_TAXI_SUGGEST_LIMIT,
  type YandexTaxiEndpoint,
} from "./yandex-taxi-config.js";

export type YandexTaxiProjection = "cancel" | "commit" | "draft" | "finalize" | "launch" | "order" | "payments" | "places" | "routestats" | "suggest" | "zoneinfo";

export interface YandexTaxiPageRequest {
  body: Record<string, unknown>;
  endpoint: YandexTaxiEndpoint;
  phoneId?: string;
  project: YandexTaxiProjection;
  /** Only for launch: send the user id the site stored, if any. */
  useStoredUserId?: boolean;
  userId?: string;
}

export interface YandexTaxiPageResult {
  /** The site's error code of a refused request (`reason.code`), e.g. PRICE_CHANGED. */
  code?: string;
  data: unknown;
  /** null, or wrong_origin:<host>, captcha, csrf_failed, shape:<field>, not_json, empty, network:<name>. */
  error: string | null;
  /** The site's text of a refused request (`reason.text`), shown to the person, never logged. */
  message?: string;
  /** Only when the call did not settle (status 0): whether the main request had started. */
  sent?: boolean;
  /** Only when the call did not settle: the step it was at (csrf, send, passport…). */
  stage?: string;
  /** HTTP status; 0 when nothing came back. */
  status: number;
}

/** In-page helpers and projections: each takes the parsed JSON body and returns the small shape. */
const PROJECTIONS = `
const obj = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : null;
const list = (v) => Array.isArray(v) ? v : null;
const str = (v, max) => typeof v === "string" ? v.slice(0, max) : typeof v === "number" && Number.isFinite(v) ? String(v).slice(0, max) : "";
const num = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
const need = (ok, field) => { if (!ok) throw new Error("shape:" + field); };
const txt = (v, max) => obj(v) ? str(v.text, max) : str(v, max);
const pos = (v) => Array.isArray(v) && v.length >= 2 && num(v[0]) !== null && num(v[1]) !== null ? [v[0], v[1]] : null;
const point = (shortText, fullText, at, uri, city) => ({ shortText: shortText || fullText, fullText, lon: at[0], lat: at[1], uri, city });
const projections = {
  launch: (raw) => {
    const r = obj(raw); need(r, "launch"); need(typeof r.id === "string" && r.id, "id"); need(typeof r.authorized === "boolean", "authorized");
    // Every listed order counts, even one without an id: it may be the car already on its way.
    const orders = (list(r.orders) || []).slice(0, 10).map((o) => ({ orderId: str(obj(o) ? o.orderid : "", 100), status: str(obj(o) ? o.status : "", 40) }));
    return { authorized: r.authorized, blocked: !!r.blocked, debt: (list(r.payment_statuses_filter) || []).includes("debt"), orders, phoneId: str(r.personal_phone_id, 100), userId: str(r.id, 100) };
  },
  places: (raw) => {
    const r = obj(raw); need(r && list(r.places), "places");
    return r.places.map(obj).filter(Boolean).map((p) => { const a = obj(p.address) || {}; const at = pos(a.point); return at ? { name: str(p.name, 100), point: point(str(a.short_text, 200), str(a.full_text, 300), at, str(a.uri, 300), str(a.city, 100)) } : null; }).filter(Boolean).slice(0, ${YANDEX_TAXI_PLACES_LIMIT});
  },
  suggest: (raw) => {
    const r = obj(raw); need(r && list(r.results), "results");
    // The log goes back to finalsuggest untouched; it never reaches the model.
    return r.results.map(obj).filter(Boolean).slice(0, ${YANDEX_TAXI_SUGGEST_LIMIT}).map((s) => ({ log: s.log === undefined ? null : s.log, position: pos(s.position), subtitle: txt(s.subtitle, 200), title: txt(s.title, 200) || str(s.text, 200) }));
  },
  finalize: (raw) => {
    const r = obj(raw); need(r && list(r.results) && obj(r.results[0]), "results");
    const f = r.results[0]; const at = pos(f.position); need(at, "position");
    const taxi = obj(obj(r.services) && r.services.taxi) || {}; const reason = obj(taxi.unavailability_reason) || {};
    return { available: taxi.available !== false, entrance: str(f.entrance, 40), point: point(txt(f.title, 200), str(f.text, 300), at, str(f.uri, 300), str(f.city, 100)), unavailableReason: str(reason.message, 300), zone: str(taxi.nearest_zone, 100) };
  },
  zoneinfo: (raw) => {
    const r = obj(raw); need(r && list(r.max_tariffs), "max_tariffs");
    const tariffs = r.max_tariffs.map(obj).filter((t) => t && typeof t.class === "string" && t.class).slice(0, 30).map((t) => ({ class: str(t.class, 60), id: str(t.id, 100) || str(t.class, 60), name: str(t.name, 100) }));
    return { currency: str(r.currency_code, 10), tariffs };
  },
  payments: (raw) => {
    const r = obj(raw); need(r, "paymentmethods");
    const last = obj(r.last_payment_method);
    const lastId = last ? str(last.id, 120) : "";
    const digits = (n) => { const m = /(\\d{4})\\D*$/.exec(str(n, 40)); return m ? m[1] : ""; };
    const card = obj(r.card) || {}; const ya = obj(r.yandex_card) || {};
    const all = (list(card.available_cards) || []).map(obj).filter((c) => c && typeof c.id === "string" && c.id).map((c) => ({ id: str(c.id, 120), last4: digits(c.number), system: str(c.system, 40) }));
    const cards = [...all.filter((c) => c.id === lastId), ...all.filter((c) => c.id !== lastId)].slice(0, ${YANDEX_TAXI_CARD_LIMIT});
    const yandexCards = (list(ya.available_cards) || []).map(obj).filter((c) => c && typeof c.card_id === "string" && c.card_id && c.is_hidden !== true && !(obj(c.availability) && c.availability.available === false)).slice(0, 3).map((c) => ({ id: str(c.card_id, 120) }));
    // A card waiting for verification in the app (usable: false) cannot pay; only its id is kept, to say so.
    const unverified = (list(card.unverified_cards) || []).map(obj).filter((c) => c && typeof c.id === "string" && c.id).slice(0, ${YANDEX_TAXI_CARD_LIMIT}).map((c) => str(c.id, 120));
    return { cards, last: last && typeof last.type === "string" ? { id: lastId, type: str(last.type, 40) } : null, unverifiedCardIds: unverified, yandexCards };
  },
  routestats: (raw) => {
    const r = obj(raw); need(r && list(r.service_levels), "service_levels"); need(typeof r.offer === "string" && r.offer, "offer");
    const rules = obj(r.currency_rules) || {};
    const levels = r.service_levels.map(obj).filter((l) => l && typeof l.class === "string" && l.class).slice(0, 30).map((l) => ({ class: str(l.class, 60), fixed: l.is_fixed_price === true, hidden: l.is_hidden === true, price: str(l.price, 120), unavailable: !!l.tariff_unavailable, waitingSeconds: num((obj(l.estimated_waiting) || {}).seconds) }));
    return { currencySign: str(rules.sign, 10), currencyText: str(rules.text, 20), levels, offer: str(r.offer, 600) };
  },
  draft: (raw) => { const r = obj(raw); need(r && typeof r.orderid === "string" && r.orderid, "orderid"); return { orderId: str(r.orderid, 100) }; },
  commit: (raw) => ({ status: str((obj(raw) || {}).status, 40) }),
  order: (raw) => {
    const r = obj(raw); need(r && typeof r.status === "string" && r.status, "status");
    const d = obj(r.driver) || {}; const cs = typeof r.cancel_state === "string" ? { state: r.cancel_state } : obj(r.cancel_state) || {}; const cr = obj(r.cancel_rules) || {};
    return { cancelDisabled: r.cancel_disabled === true, cancelMessage: str(cr.message, 500), cancelState: str(cs.state, 20), car: [str(d.color, 40), str(d.model, 80)].filter(Boolean).join(" "), driverName: str(d.short_name, 100) || str(d.name, 100), finalCost: str(r.final_cost_as_str, 40), plates: str(d.plates, 20), rating: str(d.rating, 10), status: str(r.status, 40), tariffClass: str((obj(r.tariff) || {}).class, 60), timeLeftSeconds: num((obj(r.routeinfo) || {}).time_left) };
  },
  cancel: (raw) => ({ status: str((obj(raw) || {}).status, 40) }),
};
`;

const STORED_USER_ID = `
async function storedUserId() {
  if (typeof indexedDB === "undefined" || !indexedDB) return "";
  if (indexedDB.databases) { const dbs = await indexedDB.databases(); if (!dbs.some((d) => d && d.name === "turboapp-taxi")) return ""; }
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open("turboapp-taxi");
    // Never create the site's database: aborting the upgrade leaves it to the site.
    open.onupgradeneeded = () => { try { open.transaction.abort(); } catch (e) { /* already aborted */ } };
    open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); open.onblocked = () => reject(new Error("blocked"));
  });
  try {
    if (!db.objectStoreNames.contains("redux-persist")) return "";
    const raw = await new Promise((resolve, reject) => { const get = db.transaction("redux-persist", "readonly").objectStore("redux-persist").get("persist:session"); get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error); });
    const value = typeof raw === "string" ? parse(raw) : raw;
    let id = obj(value) ? value.userId : null;
    // redux-persist stores each field JSON-encoded once more.
    if (typeof id === "string" && id.startsWith('"')) id = parse(id);
    return typeof id === "string" && id.length > 0 && id.length <= 100 ? id : "";
  } finally { db.close(); }
}
`;

export function yandexTaxiPageScript(request: YandexTaxiPageRequest): string {
  // Everything the model or the person typed reaches the page only as JSON literals.
  const literal = JSON.stringify({
    body: request.body,
    path: YANDEX_TAXI_ENDPOINTS[request.endpoint],
    phoneId: request.phoneId ?? "",
    project: request.project,
    useStoredUserId: request.useStoredUserId === true,
    userId: request.userId ?? "",
  });
  return `(async () => {
const req = ${literal};
// The tab may have been navigated elsewhere between the driver's URL check and this eval: the
// request (addresses, the account's cookies to the API host) must leave only from the taxi page.
if (location.hostname !== ${JSON.stringify(YANDEX_TAXI_HOST)}) return JSON.stringify({ status: 0, data: null, error: "wrong_origin:" + location.hostname });
const API = ${JSON.stringify(YANDEX_TAXI_API_HOST)};
${PROJECTIONS}
const parse = (t) => { try { return JSON.parse(t); } catch (e) { return null; } };
// Aborted at the call's deadline: no request of this call outlives the eval that reported it.
const whole = new AbortController();
const timed = () => AbortSignal.any([AbortSignal.timeout(${YANDEX_TAXI_FETCH_TIMEOUT_MS}), whole.signal]);
const isCaptcha = (j) => !!(obj(j) && j.type === "captcha");
const rawReasonCode = (j) => { const o = obj(j); if (!o) return ""; if (typeof o.code === "string") return o.code; if (obj(o.error) && typeof o.error.code === "string") return o.error.code; return typeof o.error === "string" ? o.error : ""; };
// Only something shaped like a code goes on to the logs; a sentence or an address becomes UNKNOWN.
const reasonCode = (j) => { const c = rawReasonCode(j); return c === "" ? "" : /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(c) ? c : "UNKNOWN"; };
const reasonText = (j) => { const o = obj(j); if (!o) return ""; const e = obj(o.error) || {}; return str(o.text, 300) || str(o.message, 300) || str(e.text, 300) || str(e.message, 300); };
const captchaHeaders = () => ({ "content-type": "application/json", "x-requested-with": "XMLHttpRequest", "x-retpath-y": location.origin + "/captcha-success" });
async function csrf(fresh) {
  if (!fresh) { try { const c = parse(localStorage.getItem("csrf_token") || "null"); if (obj(c) && typeof c.token === "string" && c.token && Number(c.validUntil) > Date.now()) return { token: c.token }; } catch (e) { /* no cached token */ } }
  const r = await fetch(API + "/csrf_token", { method: "POST", credentials: "include", cache: "reload", headers: captchaHeaders(), body: "{}", signal: timed() });
  const j = parse(await r.text());
  if (r.ok && isCaptcha(j)) return { status: r.status, error: "captcha" };
  if (!r.ok || !obj(j) || typeof j.sk !== "string" || !j.sk) return { status: r.status, error: "csrf_failed" };
  return { token: j.sk };
}
${STORED_USER_ID}
let stage = "start";
let sent = false;
const main = async () => { try {
  let userId = req.userId;
  let body = req.body;
  if (req.useStoredUserId) {
    stage = "userid";
    const stored = await Promise.race([storedUserId().catch(() => ""), new Promise((resolve) => setTimeout(() => resolve(""), 2000))]);
    if (stored) { userId = stored; body = Object.assign({}, body, { id: stored }); }
  }
  const headers = (token) => {
    const h = Object.assign(captchaHeaders(), { "accept-language": "ru", "x-taxi": navigator.userAgent + " turboapp_taxi", "x-csrf-token": token });
    const config = obj(window.clientConfig);
    if (config && typeof config.requestId === "string" && config.requestId) h["x-request-id"] = config.requestId;
    if (userId) h["x-yataxi-userid"] = userId;
    if (req.phoneId) h["x-personal-phone-id"] = req.phoneId;
    return h;
  };
  const send = async (token) => { if (whole.signal.aborted) throw new Error("deadline"); sent = true; const r = await fetch(API + req.path, { method: "POST", credentials: "include", headers: headers(token), body: JSON.stringify(body), signal: timed() }); const text = await r.text(); return { json: parse(text), r, text }; };
  stage = "csrf";
  let token = await csrf(false);
  if (token.error) return JSON.stringify({ status: token.status, data: null, error: token.error, sent });
  stage = "send";
  let res = await send(token.token);
  if (!res.r.ok && reasonCode(res.json) === "INVALID_CSRF_TOKEN") {
    // Refused before it was read: nothing the server acts on is out until the repeat starts.
    sent = false;
    stage = "csrf_retry";
    token = await csrf(true);
    if (token.error) return JSON.stringify({ status: token.status, data: null, error: token.error, sent });
    stage = "send_retry";
    res = await send(token.token);
  }
  // As the site does: a 401 first refreshes the Passport session and repeats the request once (a
  // 401 was refused before it was read, so this never sends an order twice).
  if (res.r.status === 401) {
    sent = false;
    stage = "passport";
    const update = await fetch("https://passport.yandex.ru/auth/update/", { credentials: "include", cache: "reload", signal: timed() }).then(async (r) => r.ok ? parse(await r.text()) : null).catch(() => null);
    stage = "send_after_passport";
    if (obj(update) && update.status === "ok") res = await send(token.token);
  }
  stage = "parse";
  const status = res.r.status;
  if (res.r.ok && isCaptcha(res.json)) return JSON.stringify({ status, data: null, error: "captcha" });
  if (!res.r.ok) return JSON.stringify({ status, data: null, error: null, code: reasonCode(res.json).slice(0, 80), message: reasonText(res.json) });
  if (res.json === null) return JSON.stringify({ status, data: null, error: res.text.trim() === "" ? "empty" : "not_json" });
  let data;
  try { data = projections[req.project](res.json); } catch (e) { const m = String(e && e.message || ""); return JSON.stringify({ status, data: null, error: m.startsWith("shape:") ? m.slice(0, 80) : "shape:projection" }); }
  return JSON.stringify({ status, data, error: null }).slice(0, ${YANDEX_TAXI_PAGE_RESULT_MAX_BYTES});
} catch (e) {
  return JSON.stringify({ status: 0, data: null, error: "network:" + String(e && e.name || "Error").slice(0, 40), sent, stage });
} };
let timer;
const deadline = new Promise((resolve) => { timer = setTimeout(() => { whole.abort(); resolve(JSON.stringify({ status: 0, data: null, error: "timeout", sent, stage })); }, ${YANDEX_TAXI_PAGE_DEADLINE_MS}); });
try { return await Promise.race([main(), deadline]); } finally { clearTimeout(timer); }
})()`;
}
