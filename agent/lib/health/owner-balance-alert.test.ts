/**
 * Owner balance alert tests.
 *
 * Constructs covered:
 * - Nothing is sent while the balance is healthy or unknown.
 * - A low or blocked balance is sent once per family per UTC day through the claim.
 * - A definite Telegram refusal releases the claim; any other failure abandons it with a code.
 */
import { describe, expect, it, vi } from "vitest";

import { MemoryReviewOwnerAlertTransportError } from "../memory-review/memory-review-owner-alert-transport.js";
import { createOwnerBalanceAlertDispatcher } from "./owner-balance-alert.js";

function dependencies(overrides: Partial<Parameters<typeof createOwnerBalanceAlertDispatcher>[0]> = {}) {
  return {
    abandon: vi.fn().mockResolvedValue(undefined),
    balance: vi.fn().mockResolvedValue({ available: true, totalUsd: 2 }),
    claim: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue(undefined),
    deliver: vi.fn().mockResolvedValue(undefined),
    recipients: vi.fn().mockResolvedValue([{ familyId: "family-1", ownerTelegramUserId: "101" }]),
    release: vi.fn().mockResolvedValue(undefined),
    thresholdUsd: 5,
    ...overrides,
  };
}

describe("owner balance alert", () => {
  it("stays silent on a healthy or unknown balance", async () => {
    for (const balance of [{ available: true, totalUsd: 20 }, null]) {
      const deps = dependencies({ balance: vi.fn().mockResolvedValue(balance) });
      await expect(createOwnerBalanceAlertDispatcher(deps)(new Date("2026-09-26T03:00:00.000Z"))).resolves.toBe(0);
      expect(deps.recipients).not.toHaveBeenCalled();
    }
  });

  it("warns once per day per family when the balance is low", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies({ claim: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) });
    const now = new Date("2026-09-26T03:00:00.000Z");
    await expect(createOwnerBalanceAlertDispatcher(deps)(now)).resolves.toBe(1);
    await expect(createOwnerBalanceAlertDispatcher(deps)(now)).resolves.toBe(0);
    expect(deps.deliver).toHaveBeenCalledTimes(1);
    expect((vi.mocked(deps.deliver).mock.calls[0]![0] as { text: string }).text).toContain("ниже порога 5,00 $");
    expect(deps.complete).toHaveBeenCalledWith("family-1", "2026-09-26", now);
    vi.restoreAllMocks();
  });

  it("releases the claim on a Telegram refusal and abandons it on an unclear failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refused = dependencies({ deliver: vi.fn().mockRejectedValue(new MemoryReviewOwnerAlertTransportError("failed", "AGENT_TELEGRAM_REFUSED", "нет")) });
    await createOwnerBalanceAlertDispatcher(refused)(new Date("2026-09-26T03:00:00.000Z"));
    expect(refused.release).toHaveBeenCalledWith("family-1", "2026-09-26");
    const unclear = dependencies({ deliver: vi.fn().mockRejectedValue(new Error("socket hang up")) });
    await createOwnerBalanceAlertDispatcher(unclear)(new Date("2026-09-26T03:00:00.000Z"));
    expect(unclear.abandon).toHaveBeenCalledWith("family-1", "2026-09-26", "AGENT_OWNER_BALANCE_ALERT_AMBIGUOUS");
    expect(unclear.release).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
