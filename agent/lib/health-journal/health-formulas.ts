/**
 * Health journal arithmetic: targets, daily expenditure, weight trend and workout load.
 *
 * Exports:
 * - `basalMetabolicRate`: Mifflin–St Jeor resting expenditure.
 * - `ageOn`: whole years between a birth date and a civil date.
 * - `dailyTargets`: the day's calorie, macro, fiber and water targets from a profile.
 * - `maintenanceKcal`, `deficitBlocked`, `bodyOn`: a usual day's maintenance; whether a deficit is
 *   forbidden; the formulas' body parameters on a date.
 * - `dailyExpenditure`: base + steps + workouts for one day.
 * - `weightTrend`: exponentially smoothed daily weight.
 * - `workoutLoad`: tonnage and set count of a strength workout.
 * - `addDays`, `isRealDate`, `round`: civil date and number arithmetic.
 * - `KCAL_PER_KG`, `CALORIE_FLOOR`: constants the check and the profile name.
 *
 * Key constructs (sources named so the numbers can be checked):
 * - Resting expenditure: Mifflin MD, St Jeor ST et al., Am J Clin Nutr 1990;51:241–7.
 * - Activity factors 1.2–1.9: the conventional multipliers used with Mifflin–St Jeor.
 * - A day's base is BMR × 1.1 (thermic effect of food); walking and workouts are added on top, so
 *   the day does not count movement twice. The person's earlier file journal used the same base.
 * - Walking: the horizontal term of the ACSM walking equation, 0.1 ml O₂·kg⁻¹·m⁻¹ ≈
 *   0.5 kcal·kg⁻¹·km⁻¹ net of rest; stride from height when the device gives no distance.
 * - Workouts: Compendium of Physical Activities 2011 (Ainsworth et al.), net of rest: (MET − 1).
 * - 7700 kcal per kg of body weight change: the classic approximation, also used by the weekly check.
 * - Floors: 1200 kcal (women) and 1500 kcal (men), and never below the resting expenditure.
 * - Protein 1.6 g/kg when changing weight, 1.2 g/kg when keeping it (ISSN position stand 2017 gives
 *   1.4–2.0 g/kg for exercising adults); fat 30 % of energy; fiber 14 g per 1000 kcal (Dietary
 *   Guidelines for Americans 2020–2025); water from drinks 1.6 l (women) and 2.0 l (men): 80 % of the
 *   EFSA 2010 adequate total intake, the rest comes with food.
 */

export type Sex = "female" | "male";
export type ActivityLevel = "sedentary" | "light" | "moderate" | "active" | "very_active";
export type Goal = "lose" | "maintain" | "gain";
export type WorkoutKind = "strength" | "cardio" | "sport" | "mobility";
export type Intensity = "light" | "moderate" | "vigorous";

export const KCAL_PER_KG = 7700;
export const CALORIE_FLOOR: Readonly<Record<Sex, number>> = { female: 1200, male: 1500 };
const ACTIVITY_FACTORS: Readonly<Record<ActivityLevel, number>> = {
  active: 1.725,
  light: 1.375,
  moderate: 1.55,
  sedentary: 1.2,
  very_active: 1.9,
};
const BASE_FACTOR = 1.1;
const WATER_FROM_DRINKS_ML: Readonly<Record<Sex, number>> = { female: 1600, male: 2000 };
const DEFAULT_LOSS_RATE_KG = 0.5;
const DEFAULT_GAIN_RATE_KG = 0.25;
const MAX_GAIN_RATE_KG = 0.5;
const MAX_LOSS_SHARE_OF_WEIGHT = 0.01;

/** MET values by kind and intensity (Compendium 2011): resistance 02054/02052/02050, etc. */
const WORKOUT_MET: Readonly<Record<WorkoutKind, Readonly<Record<Intensity, number>>>> = {
  cardio: { light: 4, moderate: 7, vigorous: 10 },
  mobility: { light: 2.5, moderate: 3, vigorous: 4 },
  sport: { light: 4, moderate: 6, vigorous: 8 },
  strength: { light: 3.5, moderate: 5, vigorous: 6 },
};

export interface BodyParameters {
  ageYears: number;
  heightCm: number;
  sex: Sex;
  weightKg: number;
}

export function basalMetabolicRate(body: BodyParameters): number {
  const base = 10 * body.weightKg + 6.25 * body.heightCm - 5 * body.ageYears;
  return base + (body.sex === "male" ? 5 : -161);
}

/** Whole years on `date` (both `YYYY-MM-DD`); the birthday itself counts as the new year. */
export function ageOn(birthDate: string, date: string): number {
  const [by, bm, bd] = birthDate.split("-").map(Number) as [number, number, number];
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

export interface TargetProfile {
  activityLevel: ActivityLevel | null;
  birthDate: string | null;
  deficitBlock: string | null;
  expenditureAdjustmentKcal: number;
  goal: Goal | null;
  heightCm: number | null;
  manual: {
    carbsG: number | null;
    fatG: number | null;
    fiberG: number | null;
    kcal: number | null;
    proteinG: number | null;
    waterMl: number | null;
  };
  sex: Sex | null;
  weeklyRateKg: number | null;
}

export interface DailyTargets {
  bmrKcal: number | null;
  carbsG: number | null;
  fatG: number | null;
  fiberG: number | null;
  /** True when a blocked deficit held the person's own lower number at maintenance. */
  heldAtMaintenance: boolean;
  kcal: number | null;
  /** What the formula still needs; empty when the targets are complete. */
  missing: string[];
  /** True when the floor raised the formula's calorie target. */
  limitedByFloor: boolean;
  maintenanceKcal: number | null;
  proteinG: number | null;
  source: "formula" | "manual" | "none";
  waterMl: number | null;
}

/** The weekly change the code will plan for, after its own caps. */
export function plannedWeeklyRateKg(profile: TargetProfile, weightKg: number): number {
  if (profile.goal === "lose") {
    const asked = profile.weeklyRateKg ?? DEFAULT_LOSS_RATE_KG;
    return Math.min(asked, 1, round(weightKg * MAX_LOSS_SHARE_OF_WEIGHT, 2));
  }
  if (profile.goal === "gain")
    return Math.min(profile.weeklyRateKg ?? DEFAULT_GAIN_RATE_KG, MAX_GAIN_RATE_KG);
  return 0;
}

function missingParameters(profile: TargetProfile, weightKg: number | null): string[] {
  const missing: string[] = [];
  if (profile.sex === null) missing.push("sex");
  if (profile.birthDate === null) missing.push("birthDate");
  if (profile.heightCm === null) missing.push("heightCm");
  if (weightKg === null) missing.push("weight");
  if (profile.activityLevel === null) missing.push("activityLevel");
  if (profile.goal === null) missing.push("goal");
  return missing;
}

/** The body parameters of the formulas on a date, or null while one of them is unknown. */
export function bodyOn(
  profile: TargetProfile,
  weightKg: number | null,
  date: string,
): BodyParameters | null {
  if (
    profile.sex === null ||
    profile.birthDate === null ||
    profile.heightCm === null ||
    weightKg === null
  )
    return null;
  return {
    ageYears: ageOn(profile.birthDate, date),
    heightCm: profile.heightCm,
    sex: profile.sex,
    weightKg,
  };
}

/** A minor, or a stored block (pregnancy, lactation, eating disorder, a doctor's word). */
export function deficitBlocked(profile: TargetProfile, date: string): boolean {
  return (
    profile.deficitBlock !== null ||
    (profile.birthDate !== null && ageOn(profile.birthDate, date) < 18)
  );
}

/** Maintenance of a usual day, before any correction: resting expenditure × activity factor. */
export function maintenanceKcal(body: BodyParameters, level: ActivityLevel): number {
  return basalMetabolicRate(body) * ACTIVITY_FACTORS[level];
}

export function dailyTargets(
  profile: TargetProfile,
  weightKg: number | null,
  date: string,
): DailyTargets {
  const missing = missingParameters(profile, weightKg);
  const manual = profile.manual;
  const body = bodyOn(profile, weightKg, date);
  const bmr = body === null ? null : basalMetabolicRate(body);
  // The weekly check's correction belongs to this number: it compares the weight trend with it.
  const maintenance =
    body === null || profile.activityLevel === null
      ? null
      : maintenanceKcal(body, profile.activityLevel) + profile.expenditureAdjustmentKcal;
  let formulaKcal: number | null = null;
  let limitedByFloor = false;
  if (body !== null && bmr !== null && maintenance !== null && profile.goal !== null) {
    const change = (plannedWeeklyRateKg(profile, body.weightKg) * KCAL_PER_KG) / 7;
    const planned =
      profile.goal === "lose"
        ? maintenance - change
        : profile.goal === "gain"
          ? maintenance + Math.min(change, 500)
          : maintenance;
    // Every goal keeps the floor: a weekly correction can lower maintenance itself.
    const floor = Math.max(CALORIE_FLOOR[body.sex], bmr);
    limitedByFloor = planned < floor;
    formulaKcal = Math.max(planned, floor);
  }
  // A blocked deficit holds even the person's own number at maintenance, whenever maintenance
  // becomes known: a target set before the first weigh-in is checked here, not only when set.
  const heldAtMaintenance =
    manual.kcal !== null &&
    maintenance !== null &&
    deficitBlocked(profile, date) &&
    manual.kcal < maintenance - 100;
  const kcal = heldAtMaintenance
    ? roundTo(maintenance!, 10)
    : (manual.kcal ?? (formulaKcal === null ? null : roundTo(formulaKcal, 10)));
  const proteinPerKg = profile.goal === "maintain" ? 1.2 : 1.6;
  const proteinG =
    manual.proteinG ??
    (weightKg === null || profile.goal === null ? null : Math.round(weightKg * proteinPerKg));
  const fatG = manual.fatG ?? (kcal === null ? null : Math.round((kcal * 0.3) / 9));
  const carbsG =
    manual.carbsG ??
    (kcal === null || proteinG === null || fatG === null
      ? null
      : Math.max(0, Math.round((kcal - proteinG * 4 - fatG * 9) / 4)));
  const fiberG =
    manual.fiberG ?? (kcal === null ? null : Math.max(25, Math.round((kcal / 1000) * 14)));
  const waterMl =
    manual.waterMl ?? (profile.sex === null ? null : WATER_FROM_DRINKS_ML[profile.sex]);
  return {
    bmrKcal: bmr === null ? null : Math.round(bmr),
    carbsG,
    fatG,
    fiberG,
    heldAtMaintenance,
    kcal,
    limitedByFloor: manual.kcal === null && limitedByFloor,
    maintenanceKcal: maintenance === null ? null : roundTo(maintenance, 10),
    missing: manual.kcal === null ? missing : [],
    proteinG,
    source:
      manual.kcal !== null && !heldAtMaintenance ? "manual" : kcal === null ? "none" : "formula",
    waterMl,
  };
}

export interface ExpenditureInput {
  body: BodyParameters;
  distanceM: number | null;
  steps: number | null;
  workouts: ReadonlyArray<{ durationMin: number; intensity: Intensity; kind: WorkoutKind }>;
}

export interface Expenditure {
  baseKcal: number;
  stepsKcal: number;
  totalKcal: number;
  workoutsKcal: number;
}

export function walkingKcal(
  body: BodyParameters,
  steps: number | null,
  distanceM: number | null,
): number {
  const stride = (body.heightCm / 100) * (body.sex === "male" ? 0.415 : 0.413);
  const distance = distanceM ?? (steps === null ? 0 : steps * stride);
  return 0.0005 * body.weightKg * distance;
}

function workoutKcal(
  weightKg: number,
  workout: { durationMin: number; intensity: Intensity; kind: WorkoutKind },
): number {
  return (WORKOUT_MET[workout.kind][workout.intensity] - 1) * weightKg * (workout.durationMin / 60);
}

export function dailyExpenditure(input: ExpenditureInput): Expenditure {
  // The weekly correction is not added here: it calibrates the target's maintenance, a different
  // formula (owner's decision, 11 November 2026); the evening balance stays an honest «≈».
  const base = basalMetabolicRate(input.body) * BASE_FACTOR;
  const steps = walkingKcal(input.body, input.steps, input.distanceM);
  const workouts = input.workouts.reduce(
    (sum, workout) => sum + workoutKcal(input.body.weightKg, workout),
    0,
  );
  return {
    baseKcal: Math.round(base),
    stepsKcal: Math.round(steps),
    totalKcal: Math.round(base + steps + workouts),
    workoutsKcal: Math.round(workouts),
  };
}

/**
 * The smoothed weight of each weigh-in day: 10 % of the gap closes per weigh-in, as in Walker's
 * «Hacker's Diet». Days arrive sorted, one mean weight per day; the first day seeds the trend.
 */
export function weightTrend(
  days: ReadonlyArray<{ date: string; weightKg: number }>,
): Array<{ date: string; trendKg: number; weightKg: number }> {
  let trend: number | null = null;
  return days.map((day) => {
    trend = trend === null ? day.weightKg : trend + 0.1 * (day.weightKg - trend);
    return { date: day.date, trendKg: round(trend, 2), weightKg: day.weightKg };
  });
}

export function normalizeExerciseKey(name: string): string {
  return name.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/gu, " ");
}

export function workoutLoad(
  sets: ReadonlyArray<{ reps: number | null; weightKg: number | null }>,
): { setCount: number; tonnageKg: number } {
  const tonnage = sets.reduce(
    (sum, set) => sum + (set.weightKg !== null && set.reps !== null ? set.weightKg * set.reps : 0),
    0,
  );
  return { setCount: sets.length, tonnageKg: round(tonnage, 1) };
}

/** Whether `YYYY-MM-DD` names a day that exists: «2026-02-31» and «junk» do not. */
export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(value);
}

/** Civil date arithmetic on `YYYY-MM-DD`. */
export function addDays(date: string, days: number): string {
  const time = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(time).toISOString().slice(0, 10);
}

export function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}
