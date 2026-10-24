/**
 * Eve's Bot API client reports failed sends to the reachability observer (vendored Eve,
 * `channels/telegram/api.js`, 24 October 2026).
 *
 * Constructs covered:
 * - The final failed answer of a send to a chat reaches the observer with the start of the answered
 *   attempt (the repeat after a 429, not the first try); the caller still gets Telegram's answer.
 * - A delivered send and a read never reach it; a throwing observer does not replace the answer, and
 *   one that never settles holds it no longer than 500 ms.
 */
import { callTelegramApi } from "eve/channels/telegram";
import { afterEach, describe, expect, it, vi } from "vitest";

const OBSERVER_KEY = Symbol.for("osinara.telegramDeliveryFailureObserver");
const holder = globalThis as { [key: symbol]: unknown };
const blocked = { description: "Forbidden: bot was blocked by the user", error_code: 403, ok: false };

afterEach(() => {
  delete holder[OBSERVER_KEY];
  vi.restoreAllMocks();
});

describe("Eve Telegram delivery failure report", () => {
  it("reports a blocked private chat with the start of the attempt and returns Telegram's answer", async () => {
    const observer = vi.fn(async () => undefined);
    holder[OBSERVER_KEY] = observer;
    const fetch = vi.fn(async () => Response.json(blocked, { status: 403 }));

    const before = Date.now();
    const response = await callTelegramApi({ body: { chat_id: 101, text: "секрет" }, botToken: "1:test", fetch, method: "sendMessage" });
    const after = Date.now();

    expect(response).toEqual({ body: blocked, ok: false, status: 403 });
    expect(observer).toHaveBeenCalledExactlyOnceWith({
      body: blocked, chatId: "101", method: "sendMessage", startedAt: expect.any(Number), status: 403,
    });
    const { startedAt } = (observer.mock.calls[0] as unknown as [{ startedAt: number }])[0];
    expect(startedAt).toBeGreaterThanOrEqual(before);
    expect(startedAt).toBeLessThanOrEqual(after);
  });

  it("names the start of the repeat after a 429, not of the first attempt", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const observer = vi.fn(async () => undefined);
    holder[OBSERVER_KEY] = observer;
    const starts: number[] = [];
    const fetch = vi.fn(async () => {
      starts.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 5));
      return starts.length === 1
        ? Response.json({ error_code: 429, ok: false, parameters: { retry_after: 0.01 } }, { status: 429 })
        : Response.json({ description: "Bad Request: chat not found", error_code: 400, ok: false }, { status: 400 });
    });

    await callTelegramApi({ body: { chat_id: -1007, text: "x" }, botToken: "1:test", fetch, method: "sendMessage" });

    const { startedAt } = (observer.mock.calls[0] as unknown as [{ startedAt: number }])[0];
    expect(starts).toHaveLength(2);
    expect(startedAt).toBeGreaterThan(starts[0]!);
    expect(startedAt).toBeLessThanOrEqual(starts[1]!);
  });

  it("returns Telegram's answer within the deadline when the observer never settles", async () => {
    holder[OBSERVER_KEY] = () => new Promise(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const started = Date.now();
    const response = await callTelegramApi({
      body: { chat_id: 103, text: "x" }, botToken: "1:test", fetch: vi.fn(async () => Response.json(blocked, { status: 403 })), method: "sendMessage",
    });

    expect(response.status).toBe(403);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      chatId: "103", code: "AGENT_TELEGRAM_DELIVERY_OBSERVER_REPORT_TIMEOUT", timeoutMs: 500,
    });
  });

  it("stays silent for a delivered send and a read, and survives a throwing observer", async () => {
    const observer = vi.fn(async () => undefined);
    holder[OBSERVER_KEY] = observer;
    await callTelegramApi({
      body: { chat_id: 101, text: "x" }, botToken: "1:test", fetch: vi.fn(async () => Response.json({ ok: true, result: {} })), method: "sendMessage",
    });
    await callTelegramApi({
      body: { chat_id: 101 }, botToken: "1:test", fetch: vi.fn(async () => Response.json(blocked, { status: 403 })), method: "getChat",
    });
    expect(observer).not.toHaveBeenCalled();

    holder[OBSERVER_KEY] = async () => {
      throw new Error("database down");
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await callTelegramApi({
      body: { chat_id: 102, text: "x" }, botToken: "1:test", fetch: vi.fn(async () => Response.json(blocked, { status: 403 })), method: "sendMessage",
    });
    expect(response.status).toBe(403);
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({ chatId: "102", code: "AGENT_TELEGRAM_DELIVERY_OBSERVER_FAILED" });
  });
});
