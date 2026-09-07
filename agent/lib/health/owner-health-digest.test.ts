/**
 * Owner health digest tests.
 *
 * Constructs covered:
 * - The digest names every signal it has and says "no failures" otherwise, always with memory counts.
 * - Nothing is sent before the digest hour; one send per family per day through the claim.
 * - A failed delivery releases the claim and does not stop other families.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOwnerHealthDigestDispatcher,
  digestDateFor,
  formatOwnerHealthDigest,
} from "./owner-health-digest.js";
import type { OwnerHealthReport } from "./owner-health-digest-repository.js";

const quiet: OwnerHealthReport = {
  alertDeliveryFailures: 0,
  ingressFailures: { codes: [], count: 0 },
  lanes: { blocked: [], lagging: [] },
  memoryWritten: [{ count: 3, kind: "episode", scope: "group" }, { count: 1, kind: "profile", scope: "personal" }],
  reviewBatches: { ambiguous: 0, failed: 0 },
  rotations: { count: 0, latestAt: null },
  windowStart: new Date("2026-09-08T06:00:00.000Z"),
};

describe("formatOwnerHealthDigest", () => {
  it("reports a quiet day with the memory counts", () => {
    expect(formatOwnerHealthDigest(quiet)).toBe(
      "Сводка за сутки: сбоев нет.\nПамять: +4 (group episode 3, personal profile 1).",
    );
  });

  it("names rotations, ingress failures, stuck lanes and undelivered alerts", () => {
    const text = formatOwnerHealthDigest({
      ...quiet,
      alertDeliveryFailures: 1,
      ingressFailures: { codes: [{ code: "AGENT_TELEGRAM_DISPATCH_FAILED", count: 2 }], count: 2 },
      lanes: {
        blocked: [{ code: "MODEL_CALL_FAILED", headStatus: "failed", label: "Ft86 скуф", waiting: 1400 }],
        lagging: [{ label: "BotBattle", oldestAt: new Date("2026-09-08T20:15:00.000Z"), waiting: 80 }],
      },
      memoryWritten: [],
      reviewBatches: { ambiguous: 1, failed: 2 },
      rotations: { count: 1, latestAt: new Date("2026-09-08T18:41:00.000Z") },
    });
    expect(text).toBe([
      "Сводка за сутки.",
      "Сессии: 1 ротаций после сбоя, последняя 8 сентября в 21:41.",
      "Очередь Telegram: 2 сбоев (AGENT_TELEGRAM_DISPATCH_FAILED ×2).",
      "Проверка памяти «Ft86 скуф» стоит: голова failed (MODEL_CALL_FAILED), ждут 1400 сообщений.",
      "Проверка памяти «BotBattle» отстаёт: 80 сообщений с 8 сентября в 23:15.",
      "Пакеты проверки: failed 2, ambiguous 1.",
      "Не доставлено предупреждений владельцу: 1.",
      "Память: новых записей нет.",
    ].join("\n"));
  });
});

describe("digestDateFor", () => {
  it("is empty before the digest hour and the UTC date after it", () => {
    expect(digestDateFor(new Date("2026-09-09T05:59:00.000Z"))).toBeNull();
    expect(digestDateFor(new Date("2026-09-09T06:00:00.000Z"))).toBe("2026-09-09");
    expect(digestDateFor(new Date("2026-09-09T23:30:00.000Z"))).toBe("2026-09-09");
  });
});

describe("createOwnerHealthDigestDispatcher", () => {
  afterEach(() => vi.restoreAllMocks());

  function dependencies(overrides: Partial<Parameters<typeof createOwnerHealthDigestDispatcher>[0]> = {}) {
    return {
      claim: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockResolvedValue(undefined),
      deliver: vi.fn().mockResolvedValue(undefined),
      recipients: vi.fn().mockResolvedValue([
        { familyId: "family-1", ownerTelegramUserId: "101" },
        { familyId: "family-2", ownerTelegramUserId: "202" },
      ]),
      release: vi.fn().mockResolvedValue(undefined),
      report: vi.fn().mockResolvedValue(quiet),
      ...overrides,
    };
  }

  it("sends nothing before the digest hour", async () => {
    const deps = dependencies();
    await expect(createOwnerHealthDigestDispatcher(deps)(new Date("2026-09-09T05:00:00.000Z"))).resolves.toBe(0);
    expect(deps.recipients).not.toHaveBeenCalled();
  });

  it("sends one digest per family and completes the claim with the text length", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies({ claim: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) });
    const now = new Date("2026-09-09T06:10:00.000Z");

    await expect(createOwnerHealthDigestDispatcher(deps)(now)).resolves.toBe(1);

    expect(deps.report).toHaveBeenCalledWith("family-1", new Date("2026-09-08T06:10:00.000Z"), now);
    expect(deps.deliver).toHaveBeenCalledTimes(1);
    expect(deps.deliver).toHaveBeenCalledWith({ chatId: "101", text: formatOwnerHealthDigest(quiet) });
    expect(deps.complete).toHaveBeenCalledWith("family-1", "2026-09-09", now, formatOwnerHealthDigest(quiet).length);
    expect(deps.release).not.toHaveBeenCalled();
  });

  it("releases the claim when Telegram fails and goes on to the next family", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = dependencies({
      deliver: vi.fn().mockRejectedValueOnce(new Error("telegram down")).mockResolvedValueOnce(undefined),
    });

    await expect(createOwnerHealthDigestDispatcher(deps)(new Date("2026-09-09T07:00:00.000Z"))).resolves.toBe(1);

    expect(deps.release).toHaveBeenCalledWith("family-1", "2026-09-09");
    expect(deps.complete).toHaveBeenCalledTimes(1);
    expect(deps.complete).toHaveBeenCalledWith("family-2", "2026-09-09", expect.any(Date), expect.any(Number));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("AGENT_OWNER_HEALTH_DIGEST_FAILED"));
  });
});
