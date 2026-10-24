/**
 * Ingress stall alert dispatch tests.
 *
 * Constructs covered:
 * - Each newly stalled message reaches every owner once, with where and since when it waits.
 * - Nothing is sent when no message is stalled.
 * - An owner whose chat is unreachable is skipped; the other owners still get the alert.
 * - When no owner can be reached the claim goes back, and the message is logged at most once an hour.
 */
import { describe, expect, it, vi } from "vitest";

import { TelegramRecipientUnreachableError } from "./memory-review/memory-review-owner-alert-transport.js";
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

  it("skips an owner whose chat is unreachable and still tells the next one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deliver = vi.fn()
      .mockRejectedValueOnce(new TelegramRecipientUnreachableError("101", "blocked"))
      .mockResolvedValueOnce(undefined);
    await expect(dispatchIngressStallAlerts({
      claim: async () => [{ chatType: "group", receivedAt: new Date("2026-10-01T22:22:00Z"), updateId: "85052828" }],
      deliver,
      recipients: async () => [{ familyId: "f", ownerTelegramUserId: "101" }, { familyId: "g", ownerTelegramUserId: "202" }],
    })).resolves.toBe(1);
    expect(deliver).toHaveBeenLastCalledWith(expect.objectContaining({ chatId: "202" }));
  });

  it("gives the claim back when no owner can be told and logs that at most once an hour", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    errors.mockClear();
    warnings.mockClear();
    const deliver = vi.fn();
    const release = vi.fn(async () => undefined);
    const quietUntil = new Map<string, number>();
    let at = new Date("2026-10-01T23:02:00Z");
    const dispatch = () => dispatchIngressStallAlerts({
      claim: async () => [{ chatType: "private", receivedAt: new Date("2026-10-01T22:22:00Z"), updateId: "85052829" }],
      deliver,
      now: () => at,
      quietUntil,
      recipients: async () => [{ familyId: "f", ownerTelegramUserId: "101" }],
      release,
      unreachable: async () => "blocked",
    });

    await dispatch();
    at = new Date("2026-10-01T23:12:00Z");
    await dispatch();

    expect(deliver).not.toHaveBeenCalled();
    expect(release.mock.calls).toEqual([["85052829"], ["85052829"]]);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warnings.mock.calls[0]?.[0]))).toEqual({
      code: "AGENT_TELEGRAM_INGRESS_STALL_ALERT_DEFERRED", owners: 1, updateId: "85052829",
    });

    at = new Date("2026-10-02T00:03:00Z");
    await dispatch();
    expect(warnings).toHaveBeenCalledTimes(2);
    errors.mockRestore();
    warnings.mockRestore();
  });

  it("keeps the claim once one owner got the alert", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deliver = vi.fn(async () => undefined);
    const release = vi.fn();
    await dispatchIngressStallAlerts({
      claim: async () => [{ chatType: "group", receivedAt: new Date("2026-10-01T22:22:00Z"), updateId: "85052830" }],
      deliver,
      recipients: async () => [{ familyId: "f", ownerTelegramUserId: "101" }, { familyId: "g", ownerTelegramUserId: "202" }],
      release,
      unreachable: async (chatId) => (chatId === "101" ? "blocked" : null),
    });
    expect(deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chatId: "202" }));
    expect(release).not.toHaveBeenCalled();
  });
});
