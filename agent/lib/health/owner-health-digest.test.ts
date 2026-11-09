/**
 * Owner health digest tests.
 *
 * Constructs covered:
 * - The digest names every signal it has and says "no failures" otherwise, always with memory
 *   counts and the turn quality line, which joins the failures when its thresholds are crossed.
 * - Nothing is sent before the digest hour; one send per family per day through the claim.
 * - A failed delivery releases the claim and does not stop other families.
 * - Telegram's webhook view: piled-up updates, a fresh delivery error, a missing webhook or a failed
 *   check are failures, read once per pass; an unreachable owner chat keeps the day's claim.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import { MemoryReviewOwnerAlertTransportError } from "../memory-review/memory-review-owner-alert-transport.js";
import {
  createOwnerHealthDigestDispatcher,
  digestDateFor,
  formatOwnerHealthDigest,
} from "./owner-health-digest.js";
import type { OwnerHealthReport } from "./owner-health-digest-repository.js";
import type { TelegramWebhookHealth } from "./telegram-webhook-health.js";
import { TelegramRecipientUnreachableError } from "../memory-review/memory-review-owner-alert-transport.js";
import {
  ownerHealthDigestDependencies,
  QUIET_OWNER_HEALTH_REPORT,
} from "./owner-health-digest.test-support.js";

const quiet = QUIET_OWNER_HEALTH_REPORT;

describe("formatOwnerHealthDigest", () => {
  const webhook = (
    pendingUpdateCount: number,
    lastErrorAt: string | null,
    lastErrorMessage: string | null = null,
  ) => ({
    lastErrorAt: lastErrorAt === null ? null : new Date(lastErrorAt),
    lastErrorMessage,
    pendingUpdateCount,
    status: "read" as const,
    url: "https://bot.example.com/eve/v1/telegram",
  });
  const withWebhook = (health: TelegramWebhookHealth) =>
    formatOwnerHealthDigest(quiet, {
      balance: null,
      previousBalanceUsd: null,
      storage: null,
      webhook: health,
    });

  it("names a webhook that piles up updates or failed within the day, and stays quiet about a healthy one", () => {
    expect(withWebhook(webhook(3, "2026-09-07T05:00:00.000Z", "old"))).toContain("сбоев нет");

    const piled = withWebhook(webhook(153, null));
    expect(piled).not.toContain("сбоев нет");
    expect(piled).toContain("Вебхук Telegram: ожидающих апдейтов 153.");

    const failing = withWebhook(
      webhook(
        4,
        "2026-09-09T02:00:00.000Z",
        `Wrong response from the webhook: 502 Bad Gateway${"!".repeat(300)}`,
      ),
    );
    expect(failing).not.toContain("сбоев нет");
    expect(failing).toContain(
      "Вебхук Telegram: ожидающих апдейтов 4, последняя ошибка доставки 9 сентября в 05:00: Wrong response from the webhook: 502 Bad Gateway",
    );
    const line = failing.split("\n").find((item) => item.startsWith("Вебхук"))!;
    expect(line.length).toBeLessThan(300);
  });

  it("reports a webhook that could not be checked, or is not set, as a failure", () => {
    expect(withWebhook({ status: "unreadable" })).toContain(
      "Вебхук Telegram: не удалось проверить вебхук.",
    );
    expect(withWebhook({ ...webhook(0, null), url: "" })).toContain(
      "Вебхук Telegram не установлен",
    );
  });

  it("puts a spent balance among the failures and a healthy one next to the memory counts", () => {
    const warning = formatOwnerHealthDigest(quiet, {
      balance: { available: false, totalUsd: -0.04 },
      previousBalanceUsd: null,
      storage: null,
    });
    expect(warning.split("\n")[0]).toBe("Сводка за сутки.");
    expect(warning).toContain("DeepSeek: запросы недоступны, баланс −0,04 $.");
    const healthy = formatOwnerHealthDigest(quiet, {
      balance: { available: true, totalUsd: 20 },
      previousBalanceUsd: null,
      storage: null,
    });
    expect(healthy.split("\n")[0]).toBe("Сводка за сутки: сбоев нет.");
    expect(healthy).toContain("DeepSeek: баланс 20,00 $.");
  });

  it("reports a quiet day with the memory counts", () => {
    expect(formatOwnerHealthDigest(quiet)).toBe(
      "Сводка за сутки: сбоев нет.\nХоды: за сутки ни одного.\nПамять: +4 (group episode 3, personal profile 1).",
    );
  });

  it("names rotations, ingress failures, stuck lanes and undelivered alerts", () => {
    const text = formatOwnerHealthDigest({
      ...quiet,
      alertDeliveryFailures: 1,
      ingressFailures: { codes: [{ code: "AGENT_TELEGRAM_DISPATCH_FAILED", count: 2 }], count: 2 },
      lanes: {
        blocked: [
          { code: "MODEL_CALL_FAILED", headStatus: "failed", label: "Ft86 скуф", waiting: 1400 },
        ],
        lagging: [
          { label: "BotBattle", oldestAt: new Date("2026-09-08T20:15:00.000Z"), waiting: 80 },
        ],
      },
      memoryWritten: [],
      reviewBatches: { ambiguous: 1, failed: 2 },
      turnQuality: { ...quiet.turnQuality, delivered: 7, failed: 3, failedToolTurns: 1, turns: 10 },
      rotations: { count: 1, latestAt: new Date("2026-09-08T18:41:00.000Z") },
      scheduleFailures: {
        count: 1,
        hiddenPersonal: 0,
        otherSchedules: { count: 0, schedules: 0 },
        schedules: [
          {
            codes: [{ code: "AGENT_SCHEDULE_DELIVERY_CONFIRMATION_MISSING", count: 1 }],
            count: 1,
            otherCodes: 0,
            title: "Утренние новости",
          },
        ],
      },
    });
    expect(text).toBe(
      [
        "Сводка за сутки.",
        "Сессии: 1 ротаций после сбоя, последняя 8 сентября в 21:41.",
        "Очередь Telegram: 2 сбоев (AGENT_TELEGRAM_DISPATCH_FAILED ×2).",
        "Проверка памяти «Ft86 скуф» стоит: голова failed (MODEL_CALL_FAILED), ждут 1400 сообщений.",
        "Проверка памяти «BotBattle» отстаёт: 80 сообщений с 8 сентября в 23:15.",
        "Пакеты проверки: failed 2, ambiguous 1.",
        "Не доставлено предупреждений владельцу: 1.",
        "Сценарии по расписанию: 1 сбоев: «Утренние новости» ×1 (AGENT_SCHEDULE_DELIVERY_CONFIRMATION_MISSING ×1).",
        "Ходы: 10, сбоев 3 (30 %), с упавшим инструментом 1, тяжёлых 0; процесс: циклов 0, повторов после ошибки 0, запрещённых инструментов 0; отклик: реакций +0 −0 ~0, ответов Мие 0, поправок 0 из 7 доставленных.",
        "Память: новых записей нет.",
      ].join("\n"),
    );
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

  const dependencies = ownerHealthDigestDependencies;

  it("sends nothing before the digest hour", async () => {
    const deps = dependencies();
    await expect(
      createOwnerHealthDigestDispatcher(deps)(new Date("2026-09-09T05:00:00.000Z")),
    ).resolves.toBe(0);
    expect(deps.recipients).not.toHaveBeenCalled();
  });

  it("sends one digest per family and completes the claim with the text length", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies({
      claim: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
    });
    const now = new Date("2026-09-09T06:10:00.000Z");

    await expect(createOwnerHealthDigestDispatcher(deps)(now)).resolves.toBe(1);

    expect(deps.report).toHaveBeenCalledWith("family-1", new Date("2026-09-08T06:10:00.000Z"), now);
    expect(deps.deliver).toHaveBeenCalledTimes(1);
    expect(deps.deliver).toHaveBeenCalledWith({
      chatId: "101",
      text: formatOwnerHealthDigest(quiet),
    });
    expect(deps.complete).toHaveBeenCalledWith(
      "family-1",
      "2026-09-09",
      now,
      formatOwnerHealthDigest(quiet).length,
      null,
    );
    expect(deps.release).not.toHaveBeenCalled();
  });

  it("adds the balance with the day's spend and records it, reading balance and disk once per pass", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies({
      balance: vi.fn().mockResolvedValue({ available: true, totalUsd: 12.5 }),
      previousBalance: vi.fn().mockResolvedValue(13.7),
      storage: vi.fn().mockResolvedValue({
        databaseBytes: 3 * 1024 ** 3,
        freeBytes: 6 * 1024 ** 3,
        totalBytes: 40 * 1024 ** 3,
      }),
    });
    const now = new Date("2026-09-26T06:10:00.000Z");
    await expect(createOwnerHealthDigestDispatcher(deps)(now)).resolves.toBe(2);
    const text = (vi.mocked(deps.deliver).mock.calls[0]![0] as { text: string }).text;
    expect(text).toContain("DeepSeek: баланс 12,50 $, за сутки −1,20 $.");
    expect(text).toContain("Обновление не пройдёт проверку места");
    expect(deps.complete).toHaveBeenCalledWith("family-1", "2026-09-26", now, text.length, 12.5);
    expect(deps.balance).toHaveBeenCalledTimes(1);
    expect(deps.storage).toHaveBeenCalledTimes(1);
    expect(deps.previousBalance).toHaveBeenCalledWith("family-1", "2026-09-26");
  });

  it("reads the webhook once per pass and puts it into the digest", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const webhook = vi.fn().mockResolvedValue({ status: "unreadable" });
    const deps = dependencies({ webhook });
    await expect(
      createOwnerHealthDigestDispatcher(deps)(new Date("2026-09-09T06:10:00.000Z")),
    ).resolves.toBe(2);
    expect(webhook).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(deps.deliver).mock.calls[0]?.[0]?.text)).toContain(
      "не удалось проверить вебхук",
    );
  });

  it("keeps the day's claim for an owner chat Telegram calls unreachable", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = dependencies({
      deliver: vi
        .fn()
        .mockRejectedValueOnce(new TelegramRecipientUnreachableError("101", "blocked"))
        .mockResolvedValueOnce(undefined),
    });

    await expect(
      createOwnerHealthDigestDispatcher(deps)(new Date("2026-09-09T06:10:00.000Z")),
    ).resolves.toBe(1);

    expect(deps.release).not.toHaveBeenCalled();
    expect(deps.complete).toHaveBeenCalledExactlyOnceWith(
      "family-2",
      "2026-09-09",
      expect.any(Date),
      expect.any(Number),
      null,
    );
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      code: "AGENT_TELEGRAM_RECIPIENT_UNREACHABLE",
      familyId: "family-1",
    });
  });

  it("releases the claim when Telegram fails and goes on to the next family", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = dependencies({
      deliver: vi
        .fn()
        .mockRejectedValueOnce(new Error("telegram down"))
        .mockResolvedValueOnce(undefined),
    });

    await expect(
      createOwnerHealthDigestDispatcher(deps)(new Date("2026-09-09T07:00:00.000Z")),
    ).resolves.toBe(1);

    expect(deps.release).toHaveBeenCalledWith("family-1", "2026-09-09");
    expect(deps.complete).toHaveBeenCalledTimes(1);
    expect(deps.complete).toHaveBeenCalledWith(
      "family-2",
      "2026-09-09",
      expect.any(Date),
      expect.any(Number),
      null,
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining("AGENT_OWNER_HEALTH_DIGEST_FAILED"));
  });

  it("sends the card instead of the text when widgets are on, with the verdict as caption", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deliverWidget = vi.fn().mockResolvedValue(undefined);
    const deps = dependencies({ deliverWidget });
    const now = new Date("2026-11-06T06:10:00.000Z");
    await expect(createOwnerHealthDigestDispatcher(deps)(now)).resolves.toBe(2);
    expect(deliverWidget).toHaveBeenCalledWith({
      caption: "Сводка за сутки: сбоев нет.",
      chatId: "101",
      html: expect.stringContaining("Сводка Мии"),
    });
    expect(deps.deliver).not.toHaveBeenCalled();
    expect(deps.complete).toHaveBeenCalledWith(
      "family-1",
      "2026-11-06",
      now,
      formatOwnerHealthDigest(quiet).length,
      null,
    );
  });

  it("sends the text with the card's failure when Telegram refused the card", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deliverWidget = vi
      .fn()
      .mockRejectedValue(
        new MemoryReviewOwnerAlertTransportError(
          "failed",
          "AGENT_OWNER_WIDGET_REJECTED",
          "Telegram не принял карточку: HTTP 400",
        ),
      );
    const deps = dependencies({ deliverWidget });
    await expect(
      createOwnerHealthDigestDispatcher(deps)(new Date("2026-11-06T06:10:00.000Z")),
    ).resolves.toBe(2);
    expect(deps.deliver).toHaveBeenCalledWith({
      chatId: "101",
      text: `${formatOwnerHealthDigest(quiet)}\nКарточка сводки не отправилась (Telegram не принял карточку: HTTP 400), поэтому текстом.`,
    });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("AGENT_OWNER_HEALTH_DIGEST_WIDGET_FAILED"),
    );
  });

  // Codex review of 1.8.55: a card that timed out may have arrived; the text must not say it did not.
  it("says the card may not have arrived when its outcome is unknown", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deliverWidget = vi
      .fn()
      .mockRejectedValue(
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      );
    const deps = dependencies({ deliverWidget });
    await createOwnerHealthDigestDispatcher(deps)(new Date("2026-11-06T06:10:00.000Z"));
    const text = String((deps.deliver as ReturnType<typeof vi.fn>).mock.calls[0]![0].text);
    expect(text).toMatch(/Карточка сводки могла не дойти/u);
    expect(text).not.toMatch(/не отправилась/u);
  });

  it("keeps a long digest within one Telegram message by sending the card's failure apart", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const long: OwnerHealthReport = {
      ...quiet,
      lanes: {
        blocked: Array.from({ length: 18 }, (_, index) => ({
          code: "AGENT_MEMORY_REVIEW_PASS_SKIPPED",
          headStatus: "failed",
          label: `Группа ${index} ${"с очень длинным названием ".repeat(4)}${index < 18 ? "и хвостом " : ""}`,
          waiting: 40 + index,
        })),
        lagging: [],
      },
    };
    const text = formatOwnerHealthDigest(long);
    // Fits one message alone, not with the note (Codex's case: 4 050 characters became 4 175).
    expect(text.length).toBeGreaterThan(3_950);
    expect(text.length).toBeLessThanOrEqual(4_096);
    const deliverWidget = vi
      .fn()
      .mockRejectedValue(
        new MemoryReviewOwnerAlertTransportError(
          "failed",
          "AGENT_OWNER_WIDGET_REJECTED",
          `Telegram не принял карточку: ${"очень длинная причина ".repeat(10)}`,
        ),
      );
    const deps = dependencies({ deliverWidget, report: vi.fn().mockResolvedValue(long) });
    await createOwnerHealthDigestDispatcher(deps)(new Date("2026-11-06T06:10:00.000Z"));
    const sent = (deps.deliver as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0].chatId === "101")
      .map((call) => String(call[0].text));
    for (const message of sent) expect(message.length).toBeLessThanOrEqual(4_096);
    expect(sent).toEqual([text, expect.stringMatching(/^Карточка сводки не отправилась/u)]);
  });

  // Codex review, 6 November 2026: a card with an unknown outcome and a refused text released the
  // claim, and every next pass sent the card again.
  it("records the day when the card may have arrived even if the text after it fails", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deliverWidget = vi
      .fn()
      .mockRejectedValue(
        new AppError("AGENT_OWNER_WIDGET_AMBIGUOUS", "Telegram не подтвердил карточку: HTTP 502"),
      );
    const deps = dependencies({
      deliver: vi.fn().mockRejectedValue(new Error("Telegram 400")),
      deliverWidget,
    });

    await createOwnerHealthDigestDispatcher(deps)(new Date("2026-11-06T06:10:00.000Z"));

    expect(deps.release).not.toHaveBeenCalled();
    expect(deps.complete).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("AGENT_OWNER_HEALTH_DIGEST_AMBIGUOUS"),
    );
  });

  it("keeps the claim and sends no text when the card says the owner chat is gone", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deliverWidget = vi
      .fn()
      .mockRejectedValueOnce(new TelegramRecipientUnreachableError("101", "blocked"))
      .mockResolvedValueOnce(undefined);
    const deps = dependencies({ deliverWidget });
    await expect(
      createOwnerHealthDigestDispatcher(deps)(new Date("2026-11-06T06:10:00.000Z")),
    ).resolves.toBe(1);
    expect(deps.deliver).not.toHaveBeenCalled();
    expect(deps.release).not.toHaveBeenCalled();
  });
});
