/**
 * fal's queue played by a stub `fetch` or a raw TCP server, for the image client tests.
 *
 * Exports:
 * - `falQueue`: answers submit, status, result (the picture inline, as `sync_mode` returns it) and
 *   cancel, each at its own route as SDK 1.10.1 built it; each step can be replaced, or left
 *   hanging until its request is aborted, as `fetch` does. A request to any other host or route is
 *   recorded, then an error: the client fetches nothing from a CDN.
 * - `rawFalQueue`: the same queue as a TCP server on 127.0.0.1 behind the real `fetch`, for what a
 *   `Response` cannot be built with: a reason phrase of any bytes, a status outside 200–599.
 * - `json`, `JPEG` (a real 2×2 picture), `REQUEST_ID`: what the tests build their answers from.
 * - `falClient`, `IMAGE_REQUEST`: the client under test and a plain request.
 * - `dropped`, `droppedEveryAddress`, `brokenAnswer`: transport failures as `fetch` and undici
 *   raise them.
 * - `OUTAGE`, `UNKNOWN`: the two failure shapes the tests expect.
 */
import { once } from "node:events";
import { createServer } from "node:net";

import { vi } from "vitest";

import { createFalImageClient } from "./fal-image-client.js";
import type { FalImageModelId } from "./fal-image-models.js";
import type { ImageGenerationRequest } from "./image-generation-client.js";

export const JPEG = Buffer.from(
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z",
  "base64",
);
export const REQUEST_ID = "01a202d3-0b06-7d63-bcdc-2e758507e698";
const JPEG_DATA_URI = `data:image/jpeg;base64,${JPEG.toString("base64")}`;
const QUEUE = "https://queue.fal.run";

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

type Route = "cancel" | "result" | "status" | "submit";

/**
 * The queue's routes, as SDK 1.10.1 built them: a submit to the endpoint, the rest under the app
 * (the endpoint's first two segments) and the job. A request id is any of fal's form, so a job
 * named `status-123` is still asked for its result.
 */
const ROUTES: ReadonlyArray<[Route, string, RegExp]> = [
  ["submit", "POST", /^\/[^/?]+\/[^/?]+(?:\/[^/?]+)*$/u],
  ["status", "GET", /^\/[^/]+\/[^/]+\/requests\/[\w-]+\/status\?logs=0$/u],
  ["result", "GET", /^\/[^/]+\/[^/]+\/requests\/[\w-]+$/u],
  ["cancel", "PUT", /^\/[^/]+\/[^/]+\/requests\/[\w-]+\/cancel$/u],
];

function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function routeOf(method: string, url: string): Route | null {
  if (!url.startsWith(`${QUEUE}/`)) return null;
  const path = url.slice(QUEUE.length);
  return ROUTES.find(([, verb, pattern]) => verb === method && pattern.test(path))?.[0] ?? null;
}

/** What the queue answers when a test does not say otherwise. */
const HAPPY: Readonly<Record<Route, { body: unknown; status: number }>> = {
  cancel: { body: { status: "CANCELLATION_REQUESTED" }, status: 202 },
  result: { body: { images: [{ content_type: "image/jpeg", url: JPEG_DATA_URI }] }, status: 200 },
  status: { body: { status: "COMPLETED" }, status: 200 },
  submit: {
    body: {
      request_id: REQUEST_ID,
      response_url: `${QUEUE}/bytedance/seedream/requests/${REQUEST_ID}`,
      status: "IN_QUEUE",
      status_url: `${QUEUE}/bytedance/seedream/requests/${REQUEST_ID}/status`,
    },
    status: 200,
  },
};

interface Call {
  body: unknown;
  headers: Headers;
  method: string;
  redirect: RequestRedirect | undefined;
  route: Route | null;
  signal: AbortSignal | undefined;
  url: string;
}

type Step = (signal: AbortSignal | undefined) => Promise<Response> | Response | "hang";

/** Never answers; gives up only when the request is aborted, as `fetch` does. */
function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** fal's queue: each step answers from `steps`, or the happy path. */
export function falQueue(steps: Partial<Record<Route, Step>> = {}) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const route = routeOf(method, url);
    // Every request is recorded before it can fail, so a test sees one to a CDN it refused.
    calls.push({
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: new Headers(init?.headers),
      method,
      redirect: init?.redirect,
      route,
      signal: init?.signal ?? undefined,
      url,
    });
    // An aborted request fails at once, before any answer, as `fetch` does.
    init?.signal?.throwIfAborted();
    if (route === null) throw new Error(`unexpected request ${method} ${url}`);
    const step = steps[route];
    const outcome =
      step === undefined
        ? json(HAPPY[route].body, HAPPY[route].status)
        : await step(init?.signal ?? undefined);
    return outcome === "hang" ? hang(init?.signal) : outcome;
  });
  const routed = (route: Route) => calls.filter((call) => call.route === route);
  return {
    calls,
    fetch,
    cancels: () => routed("cancel"),
    posts: () => routed("submit"),
    results: () => routed("result").length,
    statusPolls: () => routed("status").length,
  };
}

/** One answer of the raw queue: the status line after `HTTP/1.1 `, sent as UTF-8 bytes. */
interface RawAnswer {
  body?: unknown;
  headers?: Record<string, string>;
  status?: string;
}

/**
 * fal's queue as a TCP server on 127.0.0.1, written byte by byte: `answer` may replace any part of
 * a route's happy answer. Its `fetch` is the real one, sent to this server instead of fal.
 */
export async function rawFalQueue(answer: (route: Route | null) => RawAnswer | undefined) {
  const requests: string[] = [];
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    let received = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      const headEnd = received.indexOf("\r\n\r\n");
      if (headEnd < 0) return;
      const head = received.subarray(0, headEnd).toString("latin1");
      const length = Number(/^content-length:\s*(\d+)/imu.exec(head)?.[1] ?? 0);
      if (received.length < headEnd + 4 + length) return;
      const [method = "", path = ""] = head.split(" ");
      requests.push(`${method} ${path}`);
      const route = routeOf(method, `${QUEUE}${path}`);
      const happy = route === null ? { body: {}, status: 404 } : HAPPY[route];
      const chosen = answer(route) ?? {};
      const payload = Buffer.from(JSON.stringify(chosen.body ?? happy.body));
      const headers = Object.entries({
        "content-type": "application/json",
        ...chosen.headers,
        connection: "close",
        "content-length": String(payload.length),
      }).map(([name, value]) => `${name}: ${value}\r\n`);
      const statusLine = `HTTP/1.1 ${chosen.status ?? `${happy.status} OK`}\r\n`;
      socket.end(Buffer.concat([Buffer.from(statusLine + headers.join("") + "\r\n"), payload]));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  const origin = `http://127.0.0.1:${address.port}`;
  const fetch: typeof globalThis.fetch = (input, init) =>
    globalThis.fetch(urlOf(input).replace(QUEUE, origin), init);
  return { close: () => server.close(), fetch, origin, requests };
}

export const IMAGE_REQUEST: ImageGenerationRequest = {
  background: "auto",
  prompt: "кот на подоконнике",
  quality: "auto",
  size: "1024x1024",
};

export function falClient(
  queue: { fetch: typeof globalThis.fetch },
  overrides: {
    cancelTimeoutMs?: number;
    model?: FalImageModelId;
    pollIntervalMs?: number;
    retryBaseDelayMs?: number;
    timeoutMs?: number;
  } = {},
) {
  return createFalImageClient({
    apiKey: "key-id:key-secret",
    cancelTimeoutMs: 10_000,
    fetch: queue.fetch,
    model: "seedream-5.5",
    pollIntervalMs: 1,
    // fal's retries keep their count and order, a thousandth of their pause.
    retryBaseDelayMs: 1,
    timeoutMs: 60_000,
    ...overrides,
  });
}

/** undici's low-level error with `code` (and `syscall`), the `cause` of what `fetch` throws. */
function undiciError(code: string, syscall?: string): Error {
  return Object.assign(new Error(code), { code }, syscall === undefined ? {} : { syscall });
}

/** What `fetch` throws when undici fails with `code` in `syscall`. */
export function dropped(code: string, syscall?: string) {
  return () => {
    throw new TypeError("fetch failed", { cause: undiciError(code, syscall) });
  };
}

/**
 * What `fetch` throws when every address of the host failed (Happy Eyeballs): Node's
 * `AggregateError` with the first failure's `code` and no `syscall`, each address in `errors`.
 */
export function droppedEveryAddress(code: string, addresses: Array<[string, string?]>) {
  return () => {
    const errors = addresses.map(([inner, syscall]) => undiciError(inner, syscall));
    const cause = Object.assign(new AggregateError(errors, code), { code });
    throw new TypeError("fetch failed", { cause });
  };
}

/** An answer with `status` whose body breaks off as undici reports it: the connection dropped. */
export function brokenAnswer(status: number, headers: Record<string, string> = {}) {
  return () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"request_id":'));
          controller.error(new TypeError("terminated", { cause: undiciError("UND_ERR_SOCKET") }));
        },
      }),
      { headers: { "content-type": "application/json", ...headers }, status },
    );
}

/** Nothing was produced: the model must not hear that the picture may have been paid for. */
export const OUTAGE = {
  code: "AGENT_IMAGE_GENERATION_PROVIDER_UNAVAILABLE",
  contract: { retryable: false, sideEffectStatus: "not_started" },
};
export const UNKNOWN = { code: "AGENT_IMAGE_GENERATION_AMBIGUOUS" };
