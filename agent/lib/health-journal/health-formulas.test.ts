/**
 * Health journal arithmetic against hand-computed reference values.
 *
 * Constructs covered:
 * - Mifflin–St Jeor, age on a birthday, targets with caps and the calorie floor.
 * - A day's expenditure from base, steps (device distance or stride) and workouts.
 * - Weight trend smoothing, workout tonnage and exercise name normalization.
 * - The weekly expenditure check: a correction from stable weight, and each named shortage.
 */
import { describe, expect, it } from "vitest";

import { expenditureCheck, type ExpenditureCheckDay } from "./expenditure-check.js";
import {
  ageOn,
  basalMetabolicRate,
  dailyExpenditure,
  dailyTargets,
  isRealDate,
  normalizeExerciseKey,
  type TargetProfile,
  walkingKcal,
  weightTrend,
  workoutLoad,
} from "./health-formulas.js";

const NO_MANUAL = {
  carbsG: null,
  fatG: null,
  fiberG: null,
  kcal: null,
  proteinG: null,
  waterMl: null,
};

function profile(overrides: Partial<TargetProfile>): TargetProfile {
  return {
    activityLevel: "moderate",
    birthDate: "1986-11-11",
    deficitBlock: null,
    expenditureAdjustmentKcal: 0,
    goal: "lose",
    heightCm: 180,
    manual: NO_MANUAL,
    sex: "male",
    weeklyRateKg: 0.5,
    ...overrides,
  };
}

describe("health formulas", () => {
  it("computes resting expenditure and age", () => {
    expect(basalMetabolicRate({ ageYears: 30, heightCm: 165, sex: "female", weightKg: 64.8 })).toBe(
      1368.25,
    );
    expect(basalMetabolicRate({ ageYears: 40, heightCm: 180, sex: "male", weightKg: 80 })).toBe(
      1730,
    );
    expect(ageOn("1990-11-12", "2026-11-11")).toBe(35);
    expect(ageOn("1990-11-11", "2026-11-11")).toBe(36);
  });

  it("plans a deficit with macros, fiber and water", () => {
    expect(dailyTargets(profile({}), 80, "2026-11-11")).toEqual({
      bmrKcal: 1730,
      carbsG: 245,
      fatG: 71,
      fiberG: 30,
      heldAtMaintenance: false,
      kcal: 2130,
      limitedByFloor: false,
      maintenanceKcal: 2680,
      missing: [],
      proteinG: 128,
      source: "formula",
      waterMl: 2000,
    });
  });

  it("caps the loss rate and never plans below the floor", () => {
    const targets = dailyTargets(
      profile({
        activityLevel: "sedentary",
        birthDate: "1966-01-01",
        heightCm: 155,
        sex: "female",
        weeklyRateKg: 1,
      }),
      50,
      "2026-11-11",
    );
    expect(targets.kcal).toBe(1200);
    expect(targets.limitedByFloor).toBe(true);
    expect(targets.waterMl).toBe(1600);
  });

  it("keeps the person's own numbers and names what the formula lacks", () => {
    const manual = dailyTargets(
      profile({ manual: { ...NO_MANUAL, kcal: 1800, proteinG: 140 } }),
      80,
      "2026-11-11",
    );
    expect(manual).toMatchObject({ kcal: 1800, proteinG: 140, source: "manual", fatG: 60 });
    const empty = dailyTargets(
      profile({ birthDate: null, heightCm: null, sex: null }),
      null,
      "2026-11-11",
    );
    expect(empty).toMatchObject({ kcal: null, source: "none" });
    expect(empty.missing).toEqual(["sex", "birthDate", "heightCm", "weight"]);
  });

  it("holds the person's own lower number at maintenance while a deficit is blocked", () => {
    const pregnant = profile({
      activityLevel: "moderate",
      birthDate: "1990-01-01",
      deficitBlock: "pregnancy",
      goal: "maintain",
      heightCm: 170,
      manual: { ...NO_MANUAL, kcal: 1200 },
      sex: "female",
    });
    // Before the first weigh-in maintenance is unknown; with the weight it is known and holds.
    expect(dailyTargets(pregnant, null, "2026-11-11")).toMatchObject({
      kcal: 1200,
      source: "manual",
    });
    const held = dailyTargets(pregnant, 65, "2026-11-11");
    expect(held).toMatchObject({
      heldAtMaintenance: true,
      kcal: held.maintenanceKcal,
      source: "formula",
    });
    expect(dailyTargets({ ...pregnant, deficitBlock: null }, 65, "2026-11-11")).toMatchObject({
      heldAtMaintenance: false,
      kcal: 1200,
    });
    const minor = dailyTargets(
      { ...pregnant, birthDate: "2012-01-01", deficitBlock: null },
      50,
      "2026-11-11",
    );
    expect(minor.heldAtMaintenance).toBe(true);
  });

  it("never plans below the floor, whatever the goal and the correction", () => {
    const small = profile({
      activityLevel: "sedentary",
      birthDate: "1966-01-01",
      expenditureAdjustmentKcal: -310,
      goal: "maintain",
      heightCm: 155,
      sex: "female",
    });
    expect(dailyTargets(small, 50, "2026-11-11")).toMatchObject({
      kcal: 1200,
      limitedByFloor: true,
    });
    expect(dailyTargets({ ...small, goal: "gain" }, 50, "2026-11-11").kcal).toBeGreaterThanOrEqual(
      1200,
    );
  });

  it("knows a civil date that exists", () => {
    expect(["2026-11-11", "2028-02-29"].map(isRealDate)).toEqual([true, true]);
    expect(["2026-02-31", "2026-99-01", "junk", "2026-13-45"].map(isRealDate)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it("puts the weekly correction into maintenance, not into the day's expenditure", () => {
    const corrected = dailyTargets(
      profile({ expenditureAdjustmentKcal: 150, goal: "maintain" }),
      80,
      "2026-11-11",
    );
    expect(corrected.maintenanceKcal).toBe(2830);
    expect(corrected.kcal).toBe(2830);
  });

  it("adds walking and workouts to the base of the day", () => {
    const body = { ageYears: 30, heightCm: 165, sex: "female" as const, weightKg: 64.8 };
    expect(
      dailyExpenditure({
        body,
        distanceM: 4810,
        steps: 8199,
        workouts: [{ durationMin: 60, intensity: "moderate", kind: "strength" }],
      }),
    ).toEqual({ baseKcal: 1505, stepsKcal: 156, totalKcal: 1920, workoutsKcal: 259 });
    expect(
      walkingKcal({ ageYears: 40, heightCm: 180, sex: "male", weightKg: 80 }, 10_000, null),
    ).toBeCloseTo(298.8, 1);
  });

  it("smooths weight and sums a strength workout", () => {
    expect(
      weightTrend([
        { date: "2026-11-01", weightKg: 80 },
        { date: "2026-11-02", weightKg: 81 },
        { date: "2026-11-03", weightKg: 79 },
      ]).map((point) => point.trendKg),
    ).toEqual([80, 80.1, 79.99]);
    expect(
      workoutLoad([
        { reps: 10, weightKg: 60 },
        { reps: 10, weightKg: 60 },
        { reps: 15, weightKg: null },
      ]),
    ).toEqual({ setCount: 3, tonnageKg: 1200 });
    expect(normalizeExerciseKey("  Жим   лёжа ")).toBe("жим лежа");
  });
});

function windowDays(count: number, intakeKcal: number, formulaKcal: number): ExpenditureCheckDay[] {
  return Array.from({ length: 21 }, (_, index) => ({
    date: `2026-10-${String(10 + index).padStart(2, "0")}`,
    describedKcal: 0,
    formulaKcal,
    intakeKcal: index < count ? intakeKcal : 0,
  }));
}

function dailyWeights(from: number, to: number, weightOf: (day: number) => number) {
  return Array.from({ length: to - from + 1 }, (_, index) => {
    const day = from + index;
    const date = new Date(Date.UTC(2026, 9, day)).toISOString().slice(0, 10);
    return { date, weightKg: weightOf(day) };
  });
}

describe("expenditure check", () => {
  it("proposes a correction when stable weight contradicts the formula", () => {
    const check = expenditureCheck({
      currentAdjustmentKcal: 0,
      days: windowDays(21, 2000, 2200),
      weights: dailyWeights(1, 30, () => 80),
    });
    expect(check).toMatchObject({
      formulaKcal: 2200,
      observedKcal: 2000,
      proposedAdjustmentKcal: -200,
      status: "ok",
      trendChangeKg: 0,
    });
  });

  it("reads a falling trend as expenditure above intake", () => {
    const check = expenditureCheck({
      currentAdjustmentKcal: 0,
      days: windowDays(21, 2000, 2000),
      weights: dailyWeights(10, 30, (day) => 80 - (day - 10) * 0.05),
    });
    expect(check.status).toBe("ok");
    if (check.status !== "ok") return;
    expect(check.trendChangeKg).toBeLessThan(0);
    expect(check.observedKcal).toBeGreaterThan(2000);
  });

  it("stays silent about a change below the noise threshold", () => {
    const check = expenditureCheck({
      currentAdjustmentKcal: -150,
      days: windowDays(21, 2000, 2200),
      weights: dailyWeights(1, 30, () => 80),
    });
    expect(check).toMatchObject({ proposedAdjustmentKcal: null, status: "ok" });
  });

  it("proposes nothing when more than half of the calories were estimated from words", () => {
    const days = windowDays(21, 2000, 2200).map((day, index) => ({
      ...day,
      describedKcal: index < 11 ? 2000 : 0,
    }));
    expect(
      expenditureCheck({ currentAdjustmentKcal: 0, days, weights: dailyWeights(1, 30, () => 80) }),
    ).toMatchObject({ reason: "approximate", status: "insufficient" });
    const half = days.map((day, index) => ({ ...day, describedKcal: index < 10 ? 2000 : 0 }));
    expect(
      expenditureCheck({
        currentAdjustmentKcal: 0,
        days: half,
        weights: dailyWeights(1, 30, () => 80),
      }),
    ).toMatchObject({ proposedAdjustmentKcal: -200, status: "ok" });
  });

  it("counts the share of words over every logged calorie, small days included", () => {
    // 14 full days by label, and 7 small days of 790 kcal from words: 5530 of 33530 kcal is 16 %,
    // but the 8 small days of 3000 words-kcal below make words the majority over all calories.
    const days = windowDays(21, 2000, 2200).map((day, index) =>
      index < 14 ? day : { ...day, describedKcal: 3000, intakeKcal: 3000 },
    );
    const small = days.map((day, index) =>
      index < 14 ? { ...day, describedKcal: 0 } : { ...day, describedKcal: 790, intakeKcal: 790 },
    );
    expect(
      expenditureCheck({
        currentAdjustmentKcal: 0,
        days: small,
        weights: dailyWeights(1, 30, () => 80),
      }).status,
    ).toBe("ok");
    const wordy = days.map((day, index) =>
      index < 14 ? day : { ...day, describedKcal: 700, intakeKcal: 700 },
    );
    const mostlyWords = wordy.map((day, index) =>
      index < 14 ? { ...day, describedKcal: index < 6 ? 2000 : 0 } : day,
    );
    // Logged days (≥ 800): 14, of which 6 from words → 43 %; over all calories: (12000 + 4900) / 32900 = 51 %.
    expect(
      expenditureCheck({
        currentAdjustmentKcal: 0,
        days: mostlyWords,
        weights: dailyWeights(1, 30, () => 80),
      }),
    ).toMatchObject({ reason: "approximate", status: "insufficient" });
  });

  it("names the missing data instead of a number", () => {
    expect(
      expenditureCheck({
        currentAdjustmentKcal: 0,
        days: windowDays(10, 2000, 2200),
        weights: dailyWeights(1, 30, () => 80),
      }),
    ).toMatchObject({ loggedDays: 10, reason: "logged_days", status: "insufficient" });
    expect(
      expenditureCheck({
        currentAdjustmentKcal: 0,
        days: windowDays(21, 2000, 2200),
        weights: dailyWeights(20, 24, () => 80),
      }),
    ).toMatchObject({ reason: "weigh_ins", status: "insufficient" });
    expect(
      expenditureCheck({
        currentAdjustmentKcal: 0,
        days: windowDays(21, 2000, 2200),
        weights: dailyWeights(20, 30, () => 80),
      }),
    ).toMatchObject({ reason: "weigh_in_span", status: "insufficient" });
    expect(
      expenditureCheck({
        currentAdjustmentKcal: 0,
        days: windowDays(21, 2000, 2200).map((day) => ({ ...day, formulaKcal: null })),
        weights: dailyWeights(1, 30, () => 80),
      }),
    ).toMatchObject({ reason: "profile", status: "insufficient" });
  });
});
