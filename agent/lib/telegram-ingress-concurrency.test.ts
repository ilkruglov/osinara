/**
 * Telegram ingress drain concurrency setting.
 *
 * Constructs covered:
 * - Absent setting keeps the historical three drains.
 * - A positive integer within bounds is used as is.
 * - Anything else fails fast instead of silently draining with a guessed value.
 */
import { describe, expect, it } from "vitest";

import { telegramIngressMaxConcurrentDrains } from "./telegram-ingress-concurrency.js";

describe("telegramIngressMaxConcurrentDrains", () => {
  it("keeps three drains when the setting is absent", () => {
    expect(telegramIngressMaxConcurrentDrains({})).toBe(3);
  });

  it("uses a configured positive integer", () => {
    expect(telegramIngressMaxConcurrentDrains({ TELEGRAM_INGRESS_MAX_CONCURRENT_DRAINS: "10" })).toBe(10);
  });

  it.each(["0", "-1", "2.5", "ten", "", "101"])("rejects %j", (value) => {
    expect(() => telegramIngressMaxConcurrentDrains({ TELEGRAM_INGRESS_MAX_CONCURRENT_DRAINS: value }))
      .toThrow(expect.objectContaining({ code: "AGENT_TELEGRAM_INGRESS_CONCURRENCY_INVALID" }));
  });
});
