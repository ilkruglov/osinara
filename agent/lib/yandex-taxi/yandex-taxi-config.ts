/**
 * Yandex Go (taxi) constants: the private web API of taxi.yandex.ru, called from inside the
 * person's own logged-in browser tab, and the limits of what the tool shows and orders.
 *
 * Every path, header and body field comes from the site's public JS bundles (txf-turboapp-taxi
 * 4.145.4, read 24 October 2026); none of it is a published API and no answer was captured live
 * yet. A changed answer is a named error (`AGENT_YANDEX_TAXI_RESPONSE_INVALID`), never a guess.
 */
export const YANDEX_TAXI_ORIGIN = "https://taxi.yandex.ru";
export const YANDEX_TAXI_HOST = "taxi.yandex.ru";
/**
 * The page the calls run from: a static text on the site's origin. The API needs only that origin
 * (CORS, cookies, the site's localStorage and IndexedDB); the site's app itself navigated the tab to
 * yandex.ru on its own, and the browser daemon then waited for that load forever (live run,
 * 24 October 2026).
 */
export const YANDEX_TAXI_WORK_PATH = "/robots.txt";
/** The page is taxi.yandex.ru, the API is this host: a CORS call with the page's credentials. */
export const YANDEX_TAXI_API_HOST = "https://ya-authproxy.taxi.yandex.ru";

export const YANDEX_TAXI_ENDPOINTS = {
  finalSuggest: "/4.0/persuggest/v1/finalsuggest",
  // The site appends an (empty in a browser) query string to launch, hence the bare "?".
  launch: "/3.0/launch?",
  orderCommit: "/external/3.0/ordercommit",
  orderDraft: "/external/3.0/orderdraft",
  paymentMethods: "/3.0/paymentmethods",
  routeStats: "/3.0/routestats",
  suggest: "/4.0/persuggest/v1/suggest",
  taxiOnTheWay: "/3.0/taxiontheway",
  userPlaces: "/3.0/userplaces",
  zoneInfo: "/3.0/zoneinfo",
} as const;

export type YandexTaxiEndpoint = keyof typeof YANDEX_TAXI_ENDPOINTS;

/**
 * One request from the page may take this long. `agent-browser eval` waits for the script's promise,
 * and the browser daemon of the session runs nothing else meanwhile: a request that never settles
 * froze every browser tool of the person until the container was replaced (live run, 24 October 2026).
 */
export const YANDEX_TAXI_FETCH_TIMEOUT_MS = 10_000;
/** The whole page call settles by then, well before the CLI bound of 40 s in browser-driver.ts. */
export const YANDEX_TAXI_PAGE_DEADLINE_MS = 30_000;
/** Response bytes the page hands back; projections keep real answers far below this. */
export const YANDEX_TAXI_PAGE_RESULT_MAX_BYTES = 100_000;
export const YANDEX_TAXI_SUGGEST_LIMIT = 5;
export const YANDEX_TAXI_PLACES_LIMIT = 20;
/** Cards kept from paymentmethods; the last used one is moved first so the cut never loses it. */
export const YANDEX_TAXI_CARD_LIMIT = 10;
/** `ordercommit` answers 202 while the order is being accepted; the site repeats it 4 times, 5 s apart. */
export const YANDEX_TAXI_COMMIT_RETRIES = 4;
export const YANDEX_TAXI_COMMIT_RETRY_MS = 5_000;
/**
 * How far the price may rise between the estimate and the order. routestats moved prices by about
 * 1 % within seconds on the live run of 24 October 2026; the confirmation window names the resulting
 * ceiling, so the person agrees to it explicitly.
 */
export const YANDEX_TAXI_PRICE_RISE_PERCENT = 5;
/** Order statuses after which nothing goes on (site module 30818). */
export const YANDEX_TAXI_FINISHED_STATUSES: ReadonlySet<string> = new Set(["cancelled", "complete", "expired", "failed"]);
