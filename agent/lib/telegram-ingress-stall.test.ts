/**
 * Ingress stall alert dispatch tests.
 *
 * Constructs covered:
 * - Each newly stalled message reaches every owner once, with where and since when it waits.
 * - Nothing is sent when no message is stalled.
 */
import { describe, expect, it, vi } from "vitest";

import { dispatchIngressStallAlerts } from "./telegram-ingress-stall.js";

describe("ingress stall alerts", () => {
  it("tells every owner about each stalled message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deliver = vi.fn(async () => undefined);
    const sent = await dispatchIngressStallAlerts({
      claim: async () => [{ chatType: "private", receivedAt: new Date("2026-10-01T22:22:00Z"), updateId: "85052827" }],
      deliver,
      now: () => new Date("2026-10-01T23:02:00Z"),
      recipients: async () => [{ familyId: "f", ownerTelegramUserId: "101" }],
    });

    expect(sent).toBe(1);
    expect(deliver).toHaveBeenCalledWith({
      chatId: "101",
      text: expect.stringMatching(/в личном чате уже 40 мин \(пришло в 22:22 UTC\)/u),
    });
  });

  it("sends nothing when no message is stalled", async () => {
    const deliver = vi.fn();
    const recipients = vi.fn();
    await expect(dispatchIngressStallAlerts({ claim: async () => [], deliver, recipients })).resolves.toBe(0);
    expect(recipients).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
});
