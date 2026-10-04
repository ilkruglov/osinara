/**
 * Outbound Telegram pacing.
 *
 * Constructs covered:
 * - Methods that send nothing pass at once; sending methods wait for the global window.
 * - One private chat gets at most one message a second, one group twenty a minute, while other
 *   chats are not held back by them.
 * - A 429 with `retry_after` pauses every call for that long, capped.
 */
import { describe, expect, it } from "vitest";

import { createTelegramSendPacer, telegramRetryAfterSeconds } from "./telegram-send-pacing.js";

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

  it("spaces messages to one private chat a second apart without holding others", async () => {
    const clock = fakeClock();
    const pacer = createTelegramSendPacer({ ...clock });
    await pacer.acquire("sendMessage", { chat_id: 42 });
    await pacer.acquire("sendPhoto", { chat_id: 43 });
    expect(clock.sleeps).toEqual([]);
    clock.tick(300);
    await pacer.acquire("sendMessage", { chat_id: 42 });
    expect(clock.sleeps).toEqual([700]);
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

  it("pauses every call after a 429 for the time Telegram names, capped at a minute", async () => {
    const clock = fakeClock();
    const pacer = createTelegramSendPacer({ ...clock });
    expect(telegramRetryAfterSeconds({ ok: false, parameters: { retry_after: 7 } })).toBe(7);
    expect(telegramRetryAfterSeconds({ ok: false })).toBeNull();
    pacer.retryAfter(7);
    await pacer.waitForPause();
    expect(clock.sleeps).toEqual([7_000]);
    pacer.retryAfter(600);
    await pacer.acquire("sendMessage", { chat_id: 1 });
    expect(clock.sleeps).toEqual([7_000, 60_000]);
  });
});
