/**
 * The weekly check of the expenditure formula against the person's own weight trend.
 *
 * Export:
 * - `expenditureCheck`: observed expenditure over the last 21 days, its gap from the formula, and a
 *   proposed correction — or the named reason there is not enough data for one.
 *
 * Key constructs:
 * - Energy balance: observed expenditure = mean logged intake − trend change × 7700 kcal / days.
 *   Only days with at least `MIN_LOGGED_KCAL` count as logged: an empty or half-logged day would read
 *   as eating nothing and inflate the gap. The formula side is the same days' formula expenditure
 *   without any earlier correction, so the result is the absolute correction, not an increment.
 * - The weight side is the smoothed trend (`weightTrend`), seeded from weigh-ins before the window.
 * - Nothing changes without the person: the proposal is returned, and only `apply_adjustment` with
 *   the same number, recomputed at that moment, stores it.
 * - Logging error (estimates lean low, by a third on photos in published tests) shifts the observed
 *   number the same way; the summary says so rather than hiding it.
 */
import { KCAL_PER_KG, round, weightTrend } from "./health-formulas.js";

export const CHECK_WINDOW_DAYS = 21;
export const MIN_LOGGED_DAYS = 14;
export const MIN_WEIGH_INS = 8;
export const MIN_WEIGH_IN_SPAN_DAYS = 14;
export const MIN_LOGGED_KCAL = 800;
/** A correction smaller than this from the current one is noise, not a reason to change targets. */
export const MIN_ADJUSTMENT_CHANGE_KCAL = 100;
export const MAX_ADJUSTMENT_KCAL = 800;
/**
 * The owner's threshold (11 November 2026, after the estimate eval in
 * `.tmp/evals/health-food-estimates/`): words without grams erred by 65 % with a +51 % bias, while
 * labels, weighed food and photos stayed within +2…+5 % bias. A bias does not average out over
 * three weeks, so the check speaks only when at most half of the window's calories came from words.
 */
export const MAX_DESCRIBED_SHARE = 0.5;

export interface ExpenditureCheckDay {
  date: string;
  /** Calories of the day's entries estimated from words (`estimate_source = 'described'`). */
  describedKcal: number;
  /** Formula expenditure of the day without any stored correction; null when it cannot be computed. */
  formulaKcal: number | null;
  intakeKcal: number;
}

export type ExpenditureCheck =
  | {
      loggedDays: number;
      reason: "approximate" | "logged_days" | "profile" | "weigh_ins" | "weigh_in_span";
      status: "insufficient";
      weighIns: number;
      windowFrom: string;
      windowTo: string;
    }
  | {
      currentAdjustmentKcal: number;
      formulaKcal: number;
      loggedDays: number;
      meanIntakeKcal: number;
      observedKcal: number;
      proposedAdjustmentKcal: number | null;
      status: "ok";
      trendChangeKg: number;
      weighIns: number;
      windowFrom: string;
      windowTo: string;
    };

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function expenditureCheck(input: {
  currentAdjustmentKcal: number;
  /** The window's days, oldest first. */
  days: ReadonlyArray<ExpenditureCheckDay>;
  /** Daily mean weights up to the window's end, oldest first, including earlier ones for the seed. */
  weights: ReadonlyArray<{ date: string; weightKg: number }>;
}): ExpenditureCheck {
  const windowFrom = input.days[0]?.date ?? "";
  const windowTo = input.days.at(-1)?.date ?? "";
  const logged = input.days.filter((day) => day.intakeKcal >= MIN_LOGGED_KCAL);
  const trend = weightTrend(input.weights.filter((weight) => weight.date <= windowTo));
  const inWindow = trend.filter((point) => point.date >= windowFrom);
  const base = {
    loggedDays: logged.length,
    status: "insufficient" as const,
    weighIns: inWindow.length,
    windowFrom,
    windowTo,
  };
  if (logged.length < MIN_LOGGED_DAYS) return { ...base, reason: "logged_days" };
  if (inWindow.length < MIN_WEIGH_INS) return { ...base, reason: "weigh_ins" };
  const first = inWindow[0]!;
  const last = inWindow.at(-1)!;
  const span = daysBetween(first.date, last.date);
  if (span < MIN_WEIGH_IN_SPAN_DAYS) return { ...base, reason: "weigh_in_span" };
  if (logged.some((day) => day.formulaKcal === null)) return { ...base, reason: "profile" };
  // Over every logged calorie of the window: small half-logged days count toward the share too.
  const describedShare =
    input.days.reduce((sum, day) => sum + day.describedKcal, 0) /
    input.days.reduce((sum, day) => sum + day.intakeKcal, 0);
  if (describedShare > MAX_DESCRIBED_SHARE) return { ...base, reason: "approximate" };

  const meanIntake = logged.reduce((sum, day) => sum + day.intakeKcal, 0) / logged.length;
  const meanFormula = logged.reduce((sum, day) => sum + day.formulaKcal!, 0) / logged.length;
  const trendChange = last.trendKg - first.trendKg;
  const observed = meanIntake - (trendChange * KCAL_PER_KG) / span;
  const correction = Math.max(
    -MAX_ADJUSTMENT_KCAL,
    Math.min(MAX_ADJUSTMENT_KCAL, Math.round((observed - meanFormula) / 10) * 10),
  );
  return {
    currentAdjustmentKcal: input.currentAdjustmentKcal,
    formulaKcal: Math.round(meanFormula),
    loggedDays: logged.length,
    meanIntakeKcal: Math.round(meanIntake),
    observedKcal: Math.round(observed),
    proposedAdjustmentKcal:
      Math.abs(correction - input.currentAdjustmentKcal) >= MIN_ADJUSTMENT_CHANGE_KCAL
        ? correction
        : null,
    status: "ok",
    trendChangeKg: round(trendChange, 2),
    weighIns: inWindow.length,
    windowFrom,
    windowTo,
  };
}
