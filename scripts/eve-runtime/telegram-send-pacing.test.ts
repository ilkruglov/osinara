/**
 * Outbound Telegram pacing.
 *
 * Constructs covered:
 * - Methods that send nothing pass at once; sending methods wait for the global window.
 * - One private chat gets a quarter-second gap by default, one group twenty a minute, while
 *   other chats are not held back by them; the limits come from the environment.
 * - A 429 with `retry_after` pauses every call for that long; a pause over a minute is refused,
 *   and a pause extended meanwhile is waited out in full. Waiters go in arrival order.
 * - `reportTelegramDeliveryFailure`: a failed send to a chat reaches the application's observer with
 *   its start; a delivered send, a call without a chat and a read do not; an observer failure is
 *   logged with ids only and never thrown; an observer that never settles holds the answer only
 *   until the deadline.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTelegramSendPacer,
  reportTelegramDeliveryFailure,
  telegramRetryAfterSeconds,
  telegramSendPacerSettings,
} from "./telegram-send-pacing.js";

function fakeClock() {
  let at = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => at,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      at += ms;
    },
    sleeps,
    tick: (ms: number) => {
      at += ms;
    },
  };
}

describe("telegram send pacer", () => {
  it("lets non-sending methods through and holds the global window", async () => {
    const clock = fakeClock();
    const pacer = createTelegramSendPacer({ ...clock, globalPerSecond: 3 });
    await pacer.acquire("getFile", { file_id: "x" });
    expect(clock.sleeps).toEqual([]);
    for (let i = 0; i < 3; i += 1) await pacer.acquire("sendMessage", { chat_id: 100 + i });
    expect(clock.sleeps).toEqual([]);
    await pacer.acquire("sendMessage", { chat_id: 200 });
    expect(clock.sleeps).toEqual([1_000]);
  });

  it("spaces messages to one private chat by the gap without holding others", async () => {
    const clock = fakeClock();
    const pacer = createTelegramSendPacer({ ...clock });
    await pacer.acquire("sendMessage", { chat_id: 42 });
    await pacer.acquire("sendPhoto", { chat_id: 43 });
    expect(clock.sleeps).toEqual([]);
    clock.tick(100);
    await pacer.acquire("sendMessage", { chat_id: 42 });
    expect(clock.sleeps).toEqual([150]);
  });

  it("reads the three limits from the environment within Telegram's ceilings", () => {
    expect(telegramSendPacerSettings({})).toEqual({ globalPerSecond: 25, groupPerMinute: 20, privateGapMs: 250 });
    expect(telegramSendPacerSettings({ TELEGRAM_SEND_PRIVATE_GAP_MS: "1000", TELEGRAM_SEND_GLOBAL_PER_SECOND: "30" }))
      .toEqual({ globalPerSecond: 30, groupPerMinute: 20, privateGapMs: 1_000 });
    for (const [name, value] of [["TELEGRAM_SEND_GLOBAL_PER_SECOND", "31"], ["TELEGRAM_SEND_GROUP_PER_MINUTE", "0"], ["TELEGRAM_SEND_PRIVATE_GAP_MS", "x"]]) {
      expect(() => telegramSendPacerSettings({ [name!]: value })).toThrow("AGENT_RUNTIME_TUNING_INVALID");
    }
  });

  it("allows a group twenty messages a minute", async () => {
    const clock = fakeClock();
    const pacer = createTelegramSendPacer({ ...clock, globalPerSecond: 100 });
    for (let i = 0; i < 20; i += 1) {
      await pacer.acquire("sendMessage", { chat_id: "-100500" });
      clock.tick(100);
    }
    expect(clock.sleeps).toEqual([]);
    await pacer.acquire("sendMessage", { chat_id: "-100500" });
    expect(clock.sleeps).toEqual([60_000 - 20 * 100]);
  });

  it("pauses every call after a 429 for the time Telegram names and refuses a pause over a minute", async () => {
    const clock = fakeClock();
    const pacer = createTelegramSendPacer({ ...clock });
    expect(telegramRetryAfterSeconds({ ok: false, parameters: { retry_after: 7 } })).toBe(7);
    expect(telegramRetryAfterSeconds({ ok: false })).toBeNull();
    expect(pacer.retryAfter(7)).toBe(true);
    await pacer.waitForPause();
    expect(clock.sleeps).toEqual([7_000]);
    expect(pacer.retryAfter(600)).toBe(false);
    await pacer.acquire("sendMessage", { chat_id: 1 });
    expect(clock.sleeps).toEqual([7_000]);
  });

  it("waits out a pause that another 429 extended meanwhile", async () => {
    const clock = fakeClock();
    const pacer = createTelegramSendPacer({
      now: clock.now,
      sleep: async (ms) => {
        await clock.sleep(ms);
        // A second answer arrives while the first pause is slept out.
        if (clock.sleeps.length === 1) pacer.retryAfter(5);
      },
    });
    pacer.retryAfter(3);
    await pacer.waitForPause();
    expect(clock.sleeps).toEqual([3_000, 5_000]);
  });

  it("serves waiters in arrival order so a stream to one chat cannot starve another", async () => {
    const clock = fakeClock();
    const pacer = createTelegramSendPacer({ ...clock, globalPerSecond: 1 });
    const order: string[] = [];
    await pacer.acquire("sendMessage", { chat_id: 1 });
    const first = pacer.acquire("sendMessage", { chat_id: 2 }).then(() => order.push("second-chat"));
    const second = pacer.acquire("sendMessage", { chat_id: 1 }).then(() => order.push("first-chat-again"));
    await Promise.all([first, second]);
    expect(order).toEqual(["second-chat", "first-chat-again"]);
    expect(clock.sleeps).toEqual([1_000, 1_000]);
  });
});

describe("reportTelegramDeliveryFailure", () => {
  const OBSERVER_KEY = Symbol.for("osinara.telegramDeliveryFailureObserver");
  const holder = globalThis as { [key: symbol]: unknown };
  const blocked = { description: "Forbidden: bot was blocked by the user", error_code: 403, ok: false };

  afterEach(() => {
    delete holder[OBSERVER_KEY];
    vi.restoreAllMocks();
  });

  it("hands the failed answer of a send to a chat to the observer with the attempt's start", async () => {
    const observer = vi.fn(async () => undefined);
    holder[OBSERVER_KEY] = observer;

    await reportTelegramDeliveryFailure("sendMessage", { chat_id: 42, text: "секрет" },
      { body: blocked, ok: false, status: 403 }, 1_760_000_000_123);

    expect(observer).toHaveBeenCalledExactlyOnceWith({
      body: blocked, chatId: "42", method: "sendMessage", startedAt: 1_760_000_000_123, status: 403,
    });
  });

  it("stays silent for a delivered send, a call without a chat, a read and a missing observer", async () => {
    const observer = vi.fn(async () => undefined);
    holder[OBSERVER_KEY] = observer;
    const failed = { body: { description: "Bad Request: chat not found", ok: false }, ok: false, status: 400 };

    await reportTelegramDeliveryFailure("sendMessage", { chat_id: 42 }, { body: { ok: true }, ok: true, status: 200 }, 1);
    await reportTelegramDeliveryFailure("sendMessage", {}, failed, 1);
    await reportTelegramDeliveryFailure("getChat", { chat_id: 42 }, failed, 1);
    expect(observer).not.toHaveBeenCalled();

    delete holder[OBSERVER_KEY];
    await expect(reportTelegramDeliveryFailure("sendMessage", { chat_id: 42 }, failed, 1)).resolves.toBeUndefined();
  });

  it("returns after the deadline when the observer never settles, and logs the timeout", async () => {
    holder[OBSERVER_KEY] = () => new Promise(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const started = Date.now();
    await reportTelegramDeliveryFailure("sendMessage", { chat_id: 42 }, { body: blocked, ok: false, status: 403 }, 1, 20);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toEqual({
      chatId: "42", code: "AGENT_TELEGRAM_DELIVERY_OBSERVER_REPORT_TIMEOUT", method: "sendMessage", timeoutMs: 20,
    });
  });

  it("still logs the failure of an observer that gives up after the deadline", async () => {
    let fail: (error: Error) => void = () => undefined;
    holder[OBSERVER_KEY] = () => new Promise((_resolve, reject) => {
      fail = reject;
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await reportTelegramDeliveryFailure("sendMessage", { chat_id: 42 }, { body: blocked, ok: false, status: 403 }, 1, 5);
    fail(new Error("database down"));
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(2));

    expect(JSON.parse(String(error.mock.calls[1]?.[0]))).toMatchObject({ code: "AGENT_TELEGRAM_DELIVERY_OBSERVER_FAILED" });
  });

  it("logs an observer failure with ids only and never throws", async () => {
    holder[OBSERVER_KEY] = async () => {
      throw new Error("database down");
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(reportTelegramDeliveryFailure("sendChatAction", { chat_id: -100 },
      { body: { description: "Forbidden: user is deactivated", ok: false }, ok: false, status: 403 }, 1)).resolves.toBeUndefined();

    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toEqual({
      chatId: "-100", code: "AGENT_TELEGRAM_DELIVERY_OBSERVER_FAILED", errorName: "Error", method: "sendChatAction",
    });
  });
});
