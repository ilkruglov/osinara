/**
 * Health journal cards against Telegram's widget limits.
 *
 * Constructs covered:
 * - Day (progress and evening) and week cards pass the widget lint and fit 4 KB compressed, even
 *   with 60 long meal titles, of which only `MEAL_ROWS` rows are drawn.
 * - The numbers in the card are the summary's numbers; meal titles are escaped.
 * - The weekly check speaks its named shortage, and its proposal when there is one.
 */
import { describe, expect, it } from "vitest";

import { lintTelegramWidget } from "../telegram-widgets/telegram-widget-lint.js";
import {
  measureTelegramWidget,
  TELEGRAM_WIDGET_MAX_COMPRESSED_BYTES,
} from "../telegram-widgets/telegram-widget-limits.js";
import { checkSentence, duration, renderDayCard, renderWeekCard } from "./health-cards.js";
import type { DaySummary, WeekSummary } from "./health-summary-data.js";

const TARGETS = {
  bmrKcal: 1368,
  carbsG: 210,
  fatG: 60,
  fiberG: 25,
  heldAtMaintenance: false,
  kcal: 1800,
  limitedByFloor: false,
  maintenanceKcal: 2120,
  missing: [],
  proteinG: 104,
  source: "formula" as const,
  waterMl: 1600,
};

function day(meals: number): DaySummary {
  return {
    activity: { distanceM: 4810, restingHr: 59, steps: 8199 },
    balanceKcal: -494,
    date: "2026-11-09",
    eaten: { carbs: 90, fat: 59, fiber: 12.5, kcal: 1304, protein: 75.8, waterMl: 1000 },
    expenditure: { baseKcal: 1505, stepsKcal: 156, totalKcal: 1798, workoutsKcal: 137 },
    isToday: true,
    meals: Array.from({ length: meals }, (_, index) => ({
      approximate: index % 2 === 0,
      kcal: 100 + index,
      time: `1${index % 10}:0${index % 6}`,
      title:
        index === 0
          ? "Пицца <b>с сыром</b> & «соусом»"
          : `Очень длинное название блюда номер ${index} с подробностями`,
    })),
    remainingKcal: 496,
    sleep: { bedtime: "04:50", totalMin: 283, wakeTime: "09:33" },
    targets: TARGETS,
    weight: { trendKg: 64.6, weighedKg: 64.8 },
    workouts: [{ durationMin: 60, kind: "strength", title: "Зал", tonnageKg: 25100 }],
  };
}

function week(check: WeekSummary["check"]): WeekSummary {
  return {
    averages: {
      expenditureKcal: 1850,
      fiberG: 15,
      kcal: 1690,
      proteinG: 82,
      sleepMin: 402,
      steps: 7100,
      waterMl: 1200,
    },
    check,
    days: Array.from({ length: 7 }, (_, index) => ({
      date: `2026-11-0${index + 3}`,
      eatenKcal: index === 2 ? null : 1500 + index * 60,
      expenditureKcal: 1800,
      sleepMin: 400,
      steps: 7000,
      targetKcal: 1800,
      workouts: index % 3 === 0 ? 1 : 0,
    })),
    from: "2026-11-03",
    loggedDays: 6,
    onTargetDays: 4,
    targets: TARGETS,
    to: "2026-11-09",
    weight: {
      changeKg: -0.4,
      points: Array.from({ length: 10 }, (_, index) => ({
        date: `2026-10-${String(27 + index).padStart(2, "0")}`.replace("2026-10-32", "2026-11-01"),
        trendKg: 65 - index * 0.05,
        weightKg: 65 - index * 0.05 + (index % 2 === 0 ? 0.3 : -0.3),
      })).slice(0, 5),
      trendKg: 64.6,
    },
    workouts: { count: 3, minutes: 160, tonnageKg: 51000 },
  };
}

/** Russian numbers use a no-break space between thousands. */
const nb = (text: string) => text.replace(/(\d) (\d)/gu, "$1\u00a0$2");

function expectValidCard(html: string): void {
  const lint = lintTelegramWidget(html, { allowLinks: false });
  expect(lint.errors).toEqual([]);
  expect(lint.warnings).toEqual([]);
  expect(measureTelegramWidget(html).compressedBytes).toBeLessThanOrEqual(
    TELEGRAM_WIDGET_MAX_COMPRESSED_BYTES,
  );
}

describe("health cards", () => {
  it("draws the day with what is left, macros, meals and folded load", () => {
    const html = renderDayCard(day(3), "progress");
    expectValidCard(html);
    expect(html).toContain("<b>496</b><small>ккал осталось</small>");
    expect(html).toContain("<span>Белки</span><b>76<small> / 104</small></b>");
    expect(html).toContain("Пицца &lt;b&gt;с сыром&lt;/b&gt; &amp; «соусом»");
    expect(html).not.toContain("<b>с сыром</b>");
    expect(html).toContain("<details><summary>Сон и нагрузка</summary>");
    expect(html).toContain("4 ч 43 мин");
    expect(html).toContain("≈ — оценка по фото или со слов");
  });

  it("shows the evening balance against the day's expenditure", () => {
    const html = renderDayCard(day(3), "evening");
    expectValidCard(html);
    expect(html).toContain("<b>−494</b><small>баланс, ккал</small>");
    expect(html).toContain(nb("съедено 1 304 из 1 800 · расход ≈ 1 798"));
  });

  it("folds a long day into a fixed number of rows within the limits", () => {
    const html = renderDayCard(day(60), "progress");
    expectValidCard(html);
    expect(html.match(/class="row"><span class="m">\d\d:\d\d/gu)).toHaveLength(6);
    const hidden = day(60)
      .meals.slice(6)
      .reduce((sum, meal) => sum + meal.kcal, 0);
    expect(html).toContain(`ещё 54</span><span class="v">${hidden.toLocaleString("ru-RU")}`);
  });

  it("draws the week and speaks the weekly check", () => {
    const insufficient = week({
      loggedDays: 9,
      reason: "logged_days",
      status: "insufficient",
      weighIns: 3,
      windowFrom: "2026-10-20",
      windowTo: "2026-11-09",
    });
    const html = renderWeekCard(insufficient);
    expectValidCard(html);
    expect(html).toContain(nb("1 690<small>ккал в день</small>"));
    expect(html).toContain(nb("цель 1 800 · в норме 4 из 6"));
    expect(html).toContain("<span>3–9 ноября</span>");
    expect(html).toContain("64,6 кг · −0,4 за неделю");
    expect(checkSentence(insufficient)).toBe(
      "Сверка расхода с весом пока невозможна: записей еды 9 дней из 14 нужных за 3 недели.",
    );
    const proposal = week({
      currentAdjustmentKcal: 0,
      formulaKcal: 1800,
      loggedDays: 18,
      meanIntakeKcal: 1700,
      observedKcal: 1950,
      proposedAdjustmentKcal: 150,
      status: "ok",
      trendChangeKg: -0.5,
      weighIns: 12,
      windowFrom: "2026-10-20",
      windowTo: "2026-11-09",
    });
    expectValidCard(renderWeekCard(proposal));
    expect(checkSentence(proposal)).toBe(
      nb("Расход по динамике веса ≈ 1 950 ккал, на 150 выше формулы: можно поправить цель."),
    );
    expect(duration(402)).toBe("6 ч 42 мин");
  });
});
