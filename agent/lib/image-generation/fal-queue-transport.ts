/**
 * fal's queue over plain `fetch` (owner's decision of 22 November 2026, «Убрать SDK»), at the
 * routes and with the retries of the official SDK 1.10.1 it replaces (`queue.js`, `request.js`,
 * `retry.js`).
 *
 * Exports:
 * - `falQueueTransport`: `send` makes one request to the queue, `sendWithRetries` makes it again
 *   on what SDK 1.10.1 retried; both hand back the answer read whole (`QueueAnswer`).
 * - `QUEUE_ORIGIN`, `STATUS_RETRIES`, `QUEUE_RETRIES`, `pause`; `retryPauseMs` (exported for its
 *   test).
 *
 * Key constructs:
 * - Every request carries `Authorization: Key …` and JSON both ways, and follows no redirect
 *   (`redirect: "error"`): a submit would go out a second time, a poll would take the key to
 *   wherever the redirect points.
 * - An answer is its status code, its headers and its body. The reason phrase is never read:
 *   undici hands a non-ASCII one on as UTF-8, and rebuilding an answer with it threw. A status
 *   outside 200–599 stays the number it is, for the caller to judge.
 * - Every body is read whole with one bound (`ANSWER_MAX_BYTES`): the largest answer is a result
 *   with its picture inline, and an error may echo a source picture. A body is parsed as
 *   `Response.json()` parses it (UTF-8, a leading BOM dropped). One that broke off or ran past
 *   the bound is `unread` and reads as none: an error answer is still decided by its status, and
 *   a 2xx needs its body, so `sendWithRetries` takes such a 2xx for a failure.
 * - Retries as SDK 1.10.1 made them: a status up to six requests on 429, 500 and 502–504; a
 *   result, and a cancel (the SDK's default), up to four on 429 and 502–504; any of them on a
 *   transport failure (one of undici's codes anywhere in the `cause` chain, or a bare
 *   "fetch failed", which a refused redirect is too), never on an abort or on a body past the
 *   bound (a `RangeError`). The pause doubles from 1 s, ±25 % at random; the SDK's caps of 30 s
 *   and 60 s are not reached by these counts. Unlike the SDK's, the pause ends with the
 *   request's signal, so a cancel after the deadline is not late.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { readBoundedBody } from "../bounded-body.js";
import { asRecord } from "../json-value.js";

export const QUEUE_ORIGIN = "https://queue.fal.run";
/** A result with its picture inline (`MAX_IMAGE_BYTES` as base64) and room for its JSON. */
const ANSWER_MAX_BYTES = 48 * 1_024 * 1_024;
const RETRY_BASE_DELAY_MS = 1_000;

export interface QueueAnswer {
  /** The body as JSON; undefined when it is empty, not JSON, or `unread`. */
  readonly body: unknown;
  readonly headers: Headers;
  /** A status of 200–299. */
  readonly ok: boolean;
  readonly status: number;
  /** What cut the body short (it broke off or ran past the bound); undefined when read whole. */
  readonly unread: unknown;
}

interface RetryPolicy {
  /** Requests at most, the first included. */
  readonly attempts: number;
  /** Statuses asked again. */
  readonly statuses: ReadonlySet<number>;
}

/** SDK 1.10.1 `QUEUE_STATUS_RETRY_CONFIG`: a status is read-only and asked more eagerly. */
export const STATUS_RETRIES: RetryPolicy = {
  attempts: 6,
  statuses: new Set([429, 500, 502, 503, 504]),
};
/** SDK 1.10.1 `QUEUE_RETRY_CONFIG` of a result, and `DEFAULT_RETRY_OPTIONS` of a cancel: alike. */
export const QUEUE_RETRIES: RetryPolicy = { attempts: 4, statuses: new Set([429, 502, 503, 504]) };

/** undici's transport failures SDK 1.10.1 retried (`RETRYABLE_NETWORK_ERROR_CODES`). */
const RETRIED_NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** A transport failure SDK 1.10.1 retried (`isRetryableNetworkError`): never an abort. */
function isRetriedFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  let transport = false;
  for (
    let current = asRecord(error);
    current !== null && !seen.has(current);
    current = asRecord(current.cause)
  ) {
    seen.add(current);
    if (current.name === "AbortError" || current.name === "TimeoutError") return false;
    if (typeof current.code === "string" && RETRIED_NETWORK_CODES.has(current.code)) {
      transport = true;
    }
  }
  return transport || (error instanceof TypeError && /fetch failed/iu.test(error.message));
}

/** SDK 1.10.1's pause before retry `attempt` (1, the first): doubling from the base, ±25 %. */
export function retryPauseMs(
  attempt: number,
  baseMs: number,
  random: () => number = Math.random,
): number {
  return baseMs * 2 ** (attempt - 1) * (1 + 0.25 * (random() * 2 - 1));
}

/** Waits `ms`, or throws the signal's reason as soon as it aborts. */
export async function pause(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal });
  } catch {
    signal.throwIfAborted();
  }
}

/** A body as `Response.json()` reads it (UTF-8, a leading BOM dropped); undefined if not JSON. */
function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return undefined;
  }
}

export function falQueueTransport(options: {
  apiKey: string;
  fetch: typeof globalThis.fetch;
  retryBaseDelayMs?: number;
}) {
  const retryBaseDelayMs = options.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;

  /** One request; only a failure to get an answer at all is thrown. */
  async function send(
    method: "GET" | "POST" | "PUT",
    url: string,
    signal: AbortSignal,
    input?: Record<string, unknown>,
  ): Promise<QueueAnswer> {
    const response = await options.fetch(url, {
      body: input === undefined ? undefined : JSON.stringify(input),
      headers: {
        accept: "application/json",
        authorization: `Key ${options.apiKey}`,
        "content-type": "application/json",
      },
      method,
      redirect: "error",
      signal,
    });
    let body: unknown;
    let unread: unknown;
    try {
      const bytes = await readBoundedBody(
        response,
        ANSWER_MAX_BYTES,
        () => new RangeError("fal answer past its bound"),
      );
      body = parseJson(bytes);
    } catch (error) {
      unread = error;
    }
    return { body, headers: response.headers, ok: response.ok, status: response.status, unread };
  }

  /**
   * A request asked again on what SDK 1.10.1 retried. The last answer comes back whatever its
   * status, for the caller to judge; the last failure to get one is thrown.
   */
  async function sendWithRetries(
    method: "GET" | "PUT",
    url: string,
    policy: RetryPolicy,
    signal: AbortSignal,
  ): Promise<QueueAnswer> {
    for (let attempt = 1; ; attempt += 1) {
      let answer: QueueAnswer;
      try {
        answer = await send(method, url, signal);
        // A 2xx is its body: one that broke off failed as the connection under it did.
        if (answer.ok && answer.unread !== undefined) throw answer.unread;
      } catch (error) {
        if (attempt >= policy.attempts || signal.aborted || !isRetriedFailure(error)) throw error;
        await pause(retryPauseMs(attempt, retryBaseDelayMs), signal);
        continue;
      }
      if (attempt >= policy.attempts || !policy.statuses.has(answer.status)) return answer;
      await pause(retryPauseMs(attempt, retryBaseDelayMs), signal);
    }
  }

  return { send, sendWithRetries };
}
