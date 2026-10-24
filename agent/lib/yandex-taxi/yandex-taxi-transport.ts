/**
 * One Yandex Go API call through the person's browser tab, and the session it needs.
 *
 * Exports:
 * - `createYandexTaxiTransport`: `call` (the raw page result), `ok` (data or a named error),
 *   `launch` (the raw session state) and `session` (an authorized session or a named error).
 * - `YandexTaxiSession`, `YandexTaxiDriver`, `yandexTaxiSiteRefusal`, `yandexTaxiUnsettled`.
 * - `yandexTaxiNothingSent`, `isYandexTaxiNothingSent`: a failure before a side effect left the tab.
 *
 * Key constructs:
 * - The calls run from the static `YANDEX_TAXI_WORK_PATH` page of taxi.yandex.ru, never from the
 *   site's app: a tab elsewhere (another site or the app) is navigated there first; a tab that still
 *   is not there (a redirect) is `AGENT_YANDEX_TAXI_TAB_UNAVAILABLE`, a tab that moved during the eval
 *   is `AGENT_YANDEX_TAXI_TAB_MOVED`. In both cases the page sent nothing.
 * - No login, an unconfirmed phone, a block and a captcha each have their own code and a Russian
 *   message saying what the person can do; a captcha is never worked around.
 * - Logs carry the code, the endpoint, the HTTP status and the site's error code, never the site's
 *   text, addresses or names.
 */
import { AppError } from "../app-error.js";
import type { BrowserDriver } from "../browser/browser-driver.js";
import { YANDEX_TAXI_HOST, YANDEX_TAXI_ORIGIN, YANDEX_TAXI_WORK_PATH, type YandexTaxiEndpoint } from "./yandex-taxi-config.js";
import type { YandexTaxiLaunchOrder } from "./yandex-taxi-model.js";
import { yandexTaxiPageScript, type YandexTaxiPageRequest, type YandexTaxiPageResult } from "./yandex-taxi-page-script.js";

export type YandexTaxiDriver = Pick<BrowserDriver, "eval" | "open" | "settle" | "url">;

export interface YandexTaxiSession {
  authorized: boolean;
  blocked: boolean;
  debt: boolean;
  orders: YandexTaxiLaunchOrder[];
  phoneId: string;
  userId: string;
}

const LOGIN_HINT = "войдите в Яндекс в браузере Мии (browser_open https://passport.yandex.ru/auth, номер телефона и код из СМС) и повторите";

export const yandexTaxiErrors = {
  authRequired: () => new AppError("AGENT_YANDEX_TAXI_AUTH_REQUIRED", `Яндекс Go не узнаёт вход: ${LOGIN_HINT}`),
  // By the site's UI code an account without a confirmed phone launches with authorized=false.
  phoneUnconfirmed: () => new AppError(
    "AGENT_YANDEX_TAXI_AUTH_REQUIRED",
    "Яндекс Go не считает вход подтверждённым: нужен вход в Яндекс с подтверждённым номером телефона. В браузере Мии откройте https://passport.yandex.ru/auth (browser_open), войдите по номеру и коду из СМС, при запросе подтвердите телефон, потом повторите",
  ),
  blocked: () => new AppError("AGENT_YANDEX_TAXI_BLOCKED", "Яндекс Go отказал аккаунту в доступе: аккаунт ограничен или запрос принят за робота. Проверьте в приложении Яндекс Go"),
  captcha: () => new AppError("AGENT_YANDEX_TAXI_CAPTCHA", "Яндекс Go показал проверку «я не робот». Обходить её я не буду: попробуйте позже или закажите в приложении Яндекс Go"),
  orderNotFound: () => new AppError("AGENT_YANDEX_TAXI_ORDER_NOT_FOUND", "Яндекс Go не нашёл такой заказ. Посмотрите status без orderId"),
  rateLimited: () => new AppError("AGENT_YANDEX_TAXI_RATE_LIMITED", "Яндекс Go временно ограничил число запросов. Попробуйте через пару минут"),
  responseInvalid: (endpoint: string, diagnostic: string) => {
    console.error(JSON.stringify({ code: "AGENT_YANDEX_TAXI_RESPONSE_INVALID", diagnostic: diagnostic.slice(0, 80), endpoint }));
    return new AppError("AGENT_YANDEX_TAXI_RESPONSE_INVALID", "Яндекс Go ответил в непонятной форме: сайт, видимо, изменился. Закажите в приложении Яндекс Go, а я сообщу о сбое");
  },
  unavailable: (endpoint: string, diagnostic: string) => {
    console.error(JSON.stringify({ code: "AGENT_YANDEX_TAXI_UNAVAILABLE", diagnostic: diagnostic.slice(0, 80), endpoint }));
    return new AppError("AGENT_YANDEX_TAXI_UNAVAILABLE", "Яндекс Go не ответил. Попробуйте позже");
  },
};

const NOTHING_SENT = new WeakSet<object>();

/**
 * Marks a failure raised before an order or a cancellation left the tab (re-pricing, re-reading the
 * order, a page call that never started its request): the operation ledger frees the call's key.
 */
export function yandexTaxiNothingSent<E>(error: E): E {
  if (typeof error === "object" && error !== null) NOTHING_SENT.add(error);
  return error;
}

export const isYandexTaxiNothingSent = (error: unknown): boolean => typeof error === "object" && error !== null && NOTHING_SENT.has(error);

/** The diagnostic of a call that came back without a status: the error and the step it stopped at. */
export const yandexTaxiUnsettled = (result: YandexTaxiPageResult): string =>
  `${result.error ?? "no_status"}${result.stage ? `@${result.stage}` : ""}`;

/** The site's own words for a refused request; the code is logged, the text only shown. */
export function yandexTaxiSiteRefusal(endpoint: YandexTaxiEndpoint, result: YandexTaxiPageResult): AppError {
  // The page passes only code-shaped values; checked again here because this line reaches the logs.
  const reason = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(result.code ?? "") ? result.code! : result.code ? "UNKNOWN" : "";
  console.error(JSON.stringify({ code: "AGENT_YANDEX_TAXI_REJECTED", endpoint, reason, status: result.status }));
  const text = (result.message ?? "").replace(/\s+/gu, " ").trim().slice(0, 300);
  const detail = text || result.code || `HTTP ${result.status}`;
  return new AppError("AGENT_YANDEX_TAXI_REJECTED", `Яндекс Go отклонил запрос: ${detail}`);
}

export function createYandexTaxiTransport(driver: YandexTaxiDriver) {
  async function location(): Promise<{ host: string; path: string }> {
    try { const url = new URL(await driver.url()); return { host: url.hostname, path: url.pathname }; } catch { return { host: "", path: "" }; }
  }

  const atWorkPage = (at: { host: string; path: string }) => at.host === YANDEX_TAXI_HOST && at.path === YANDEX_TAXI_WORK_PATH;

  async function ensureTab(): Promise<void> {
    if (atWorkPage(await location())) return;
    await driver.open(`${YANDEX_TAXI_ORIGIN}${YANDEX_TAXI_WORK_PATH}`);
    await driver.settle();
    const landed = await location();
    if (!atWorkPage(landed)) {
      console.error(JSON.stringify({ code: "AGENT_YANDEX_TAXI_TAB_UNAVAILABLE", host: landed.host.slice(0, 100) }));
      throw new AppError("AGENT_YANDEX_TAXI_TAB_UNAVAILABLE", "Сайт taxi.yandex.ru не открылся во вкладке браузера Мии. Попробуйте позже");
    }
  }

  /** The page's result; throws only when nothing usable came back or the page refused to send. */
  async function call(request: YandexTaxiPageRequest): Promise<YandexTaxiPageResult> {
    await ensureTab();
    const raw = await driver.eval(yandexTaxiPageScript(request));
    let result: YandexTaxiPageResult;
    try { result = JSON.parse(raw) as YandexTaxiPageResult; } catch { throw yandexTaxiErrors.responseInvalid(request.endpoint, "page_result_not_json"); }
    if (typeof result !== "object" || result === null || typeof result.status !== "number") throw yandexTaxiErrors.responseInvalid(request.endpoint, "page_result_shape");
    if (typeof result.error === "string" && result.error.startsWith("wrong_origin:")) {
      console.error(JSON.stringify({ code: "AGENT_YANDEX_TAXI_TAB_MOVED", endpoint: request.endpoint, host: result.error.slice(13, 113) }));
      throw new AppError("AGENT_YANDEX_TAXI_TAB_MOVED", "Вкладка браузера ушла с taxi.yandex.ru во время запроса, запрос не отправлен. Повторите действие");
    }
    if (result.error === "captcha") {
      console.error(JSON.stringify({ code: "AGENT_YANDEX_TAXI_CAPTCHA", endpoint: request.endpoint, status: result.status }));
      throw yandexTaxiErrors.captcha();
    }
    return result;
  }

  /** Data of a successful call, or the named error of every other outcome. */
  function dataOf<T>(endpoint: YandexTaxiEndpoint, result: YandexTaxiPageResult, notFound?: () => AppError): T {
    if (result.error === "csrf_failed") {
      if (result.status === 401 || result.status === 403) throw yandexTaxiErrors.authRequired();
      throw yandexTaxiErrors.unavailable(endpoint, `csrf_status_${result.status}`);
    }
    if (result.status === 401) throw yandexTaxiErrors.authRequired();
    if (result.status === 403) throw yandexTaxiErrors.blocked();
    if (result.status === 404 && notFound) throw notFound();
    if (result.status === 429) throw yandexTaxiErrors.rateLimited();
    if (result.status === 0) throw yandexTaxiErrors.unavailable(endpoint, yandexTaxiUnsettled(result));
    if (result.status >= 500) throw yandexTaxiErrors.unavailable(endpoint, `status_${result.status}`);
    if (result.status >= 400) throw yandexTaxiSiteRefusal(endpoint, result);
    if (result.data === null || result.data === undefined) throw yandexTaxiErrors.responseInvalid(endpoint, result.error ?? `status_${result.status}_no_data`);
    return result.data as T;
  }

  async function ok<T>(request: YandexTaxiPageRequest, notFound?: () => AppError): Promise<T> {
    return dataOf<T>(request.endpoint, await call(request), notFound);
  }

  /** The raw launch outcome: the `auth` action reports it, every other action needs `session`. */
  async function launch(): Promise<{ kind: "blocked" } | { kind: "login_required" } | { kind: "session"; session: YandexTaxiSession }> {
    const result = await call({ body: {}, endpoint: "launch", project: "launch", useStoredUserId: true });
    if (result.status === 401) return { kind: "login_required" };
    if (result.status === 403 && result.error !== "csrf_failed") return { kind: "blocked" };
    return { kind: "session", session: dataOf<YandexTaxiSession>("launch", result) };
  }

  async function session(): Promise<YandexTaxiSession> {
    const launched = await launch();
    if (launched.kind === "login_required") throw yandexTaxiErrors.authRequired();
    if (launched.kind === "blocked" || launched.session.blocked) throw yandexTaxiErrors.blocked();
    if (!launched.session.authorized) throw yandexTaxiErrors.phoneUnconfirmed();
    return launched.session;
  }

  return { call, launch, ok, session };
}

export type YandexTaxiTransport = ReturnType<typeof createYandexTaxiTransport>;
