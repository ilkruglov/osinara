/**
 * Outbound Telegram pacing.
 *
 * Constructs covered:
 * - Methods that send nothing pass at once; sending methods wait for the global window.
 * - One private chat gets a quarter-second gap by default, one group twenty a minute, while
 *   other chats are not held back by them; the limits come from the environment.
 * - A 429 with `retry_after` pauses every call for that long, capped.
 */
import { describe, expect, it } from "vitest";

import { createTelegramSendPacer, telegramRetryAfterSeconds, telegramSendPacerSettings } from "./telegram-send-pacing.js";

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
