/**
 * Reads the person's health state that targets, summaries and the weekly check are computed from.
 *
 * Exports:
 * - `loadProfile`: the stored profile as `TargetProfile` plus its row version and dates.
 * - `loadWeightSeries`: one mean weight per day with its smoothed trend, up to a date.
 * - `trendWeightOn`: the latest trend weight on or before a date.
 * - `expenditureOn`: the formula expenditure of one day (base, steps, workouts).
 * - `loadExpenditureCheck`: the weekly check for the 21 days before a date.
 */
import { CHECK_WINDOW_DAYS, type ExpenditureCheck, expenditureCheck } from "./expenditure-check.js";
import { type HealthTransaction, numberOrNull } from "./health-access.js";
import {
  addDays,
  bodyOn,
  dailyExpenditure,
  type Expenditure,
  maintenanceKcal,
  type Intensity,
  type TargetProfile,
  weightTrend,
  type WorkoutKind,
} from "./health-formulas.js";

interface StoredProfile {
  profile: TargetProfile;
  version: number | null;
}

interface ProfileRow {
  activity_level: TargetProfile["activityLevel"];
  birth_date: string | null;
  deficit_block: string | null;
  expenditure_adjustment_kcal: number;
  goal: TargetProfile["goal"];
  height_cm: string | null;
  manual_carbs_g: number | null;
  manual_fat_g: number | null;
  manual_fiber_g: number | null;
  manual_kcal: number | null;
  manual_protein_g: number | null;
  manual_water_ml: number | null;
  sex: TargetProfile["sex"];
  version: number;
  weekly_rate_kg: string | null;
}

const EMPTY_PROFILE: TargetProfile = {
  activityLevel: null,
  birthDate: null,
  deficitBlock: null,
  expenditureAdjustmentKcal: 0,
  goal: null,
  heightCm: null,
  manual: { carbsG: null, fatG: null, fiberG: null, kcal: null, proteinG: null, waterMl: null },
  sex: null,
  weeklyRateKg: null,
};

export async function loadProfile(tx: HealthTransaction, lock = false): Promise<StoredProfile> {
  const result = await tx.client.query<ProfileRow>(
    `SELECT sex, birth_date::text AS birth_date, height_cm, activity_level, goal, weekly_rate_kg,
            deficit_block, manual_kcal, manual_protein_g, manual_fat_g, manual_carbs_g, manual_fiber_g,
            manual_water_ml, expenditure_adjustment_kcal, version
       FROM health_profiles WHERE owner_user_id = $1${lock ? " FOR UPDATE" : ""}`,
    [tx.ownerUserId],
  );
  const row = result.rows[0];
  if (!row) return { profile: EMPTY_PROFILE, version: null };
  return {
    profile: {
      activityLevel: row.activity_level,
      birthDate: row.birth_date,
      deficitBlock: row.deficit_block,
      expenditureAdjustmentKcal: row.expenditure_adjustment_kcal,
      goal: row.goal,
      heightCm: numberOrNull(row.height_cm),
      manual: {
        carbsG: row.manual_carbs_g,
        fatG: row.manual_fat_g,
        fiberG: row.manual_fiber_g,
        kcal: row.manual_kcal,
        proteinG: row.manual_protein_g,
        waterMl: row.manual_water_ml,
      },
      sex: row.sex,
      weeklyRateKg: numberOrNull(row.weekly_rate_kg),
    },
    version: row.version,
  };
}

export interface WeightPoint {
  date: string;
  trendKg: number;
  weightKg: number;
}

/**
 * Daily means of the whole history up to `upTo`, smoothed. The whole history, not a window: the
 * trend of a date must not depend on where a loading window starts, or one date would get one
 * target in the day card and another in the week card. One row per weighed day keeps it small.
 */
export async function loadWeightSeries(
  tx: HealthTransaction,
  upTo: string,
): Promise<WeightPoint[]> {
  const result = await tx.client.query<{ date: string; weight: string }>(
    `SELECT local_date::text AS date, avg(weight_kg)::numeric(6, 2)::text AS weight
       FROM health_body_measurements
      WHERE owner_user_id = $1 AND removed_at IS NULL AND weight_kg IS NOT NULL
        AND local_date <= $2::date
      GROUP BY local_date ORDER BY local_date`,
    [tx.ownerUserId, upTo],
  );
  return weightTrend(result.rows.map((row) => ({ date: row.date, weightKg: Number(row.weight) })));
}

export function trendWeightOn(series: readonly WeightPoint[], date: string): number | null {
  let found: number | null = null;
  for (const point of series) if (point.date <= date) found = point.trendKg;
  return found;
}

export interface DayActivity {
  distanceM: number | null;
  restingHr: number | null;
  steps: number | null;
  workouts: Array<{ durationMin: number; intensity: Intensity; kind: WorkoutKind }>;
}

export async function loadActivity(
  tx: HealthTransaction,
  from: string,
  to: string,
): Promise<Map<string, DayActivity>> {
  const days = new Map<string, DayActivity>();
  const day = (date: string): DayActivity => {
    let value = days.get(date);
    if (!value) {
      value = { distanceM: null, restingHr: null, steps: null, workouts: [] };
      days.set(date, value);
    }
    return value;
  };
  const activity = await tx.client.query<{
    date: string;
    distance_m: number | null;
    resting_hr: number | null;
    steps: number | null;
  }>(
    `SELECT local_date::text AS date, steps, distance_m, resting_hr FROM health_activity_days
      WHERE owner_user_id = $1 AND local_date BETWEEN $2::date AND $3::date`,
    [tx.ownerUserId, from, to],
  );
  for (const row of activity.rows)
    Object.assign(day(row.date), {
      distanceM: row.distance_m,
      restingHr: row.resting_hr,
      steps: row.steps,
    });
  const workouts = await tx.client.query<{
    date: string;
    duration_min: number;
    intensity: Intensity;
    kind: WorkoutKind;
  }>(
    `SELECT local_date::text AS date, duration_min, intensity, kind FROM health_workouts
      WHERE owner_user_id = $1 AND removed_at IS NULL AND local_date BETWEEN $2::date AND $3::date`,
    [tx.ownerUserId, from, to],
  );
  for (const row of workouts.rows)
    day(row.date).workouts.push({
      durationMin: row.duration_min,
      intensity: row.intensity,
      kind: row.kind,
    });
  return days;
}

/** The formula expenditure of a day; null when the profile or the weight is missing. */
export function expenditureOn(
  profile: TargetProfile,
  series: readonly WeightPoint[],
  activity: DayActivity | undefined,
  date: string,
): Expenditure | null {
  const body = bodyOn(profile, trendWeightOn(series, date), date);
  if (body === null) return null;
  return dailyExpenditure({
    body,
    distanceM: activity?.distanceM ?? null,
    steps: activity?.steps ?? null,
    workouts: activity?.workouts ?? [],
  });
}

/**
 * The day's maintenance before any correction, what the weekly check calibrates. Days logged before
 * the first weigh-in take the first trend weight: a complete profile is complete on those days too.
 */
function maintenanceOn(
  profile: TargetProfile,
  series: readonly WeightPoint[],
  date: string,
): number | null {
  const body = bodyOn(profile, trendWeightOn(series, date) ?? series[0]?.trendKg ?? null, date);
  return body === null || profile.activityLevel === null
    ? null
    : maintenanceKcal(body, profile.activityLevel);
}

/** Each day's logged calories, and how many of them were estimated from words. */
async function loadIntake(
  tx: HealthTransaction,
  from: string,
  to: string,
): Promise<Map<string, { describedKcal: number; kcal: number }>> {
  const result = await tx.client.query<{ date: string; described: string; kcal: string }>(
    `SELECT local_date::text AS date, sum(kcal)::text AS kcal,
            coalesce(sum(kcal) FILTER (WHERE estimate_source = 'described'), 0)::text AS described
       FROM health_food_entries
      WHERE owner_user_id = $1 AND removed_at IS NULL AND local_date BETWEEN $2::date AND $3::date
      GROUP BY local_date`,
    [tx.ownerUserId, from, to],
  );
  return new Map(
    result.rows.map((row) => [
      row.date,
      { describedKcal: Number(row.described), kcal: Number(row.kcal) },
    ]),
  );
}

/** The weekly check over the `CHECK_WINDOW_DAYS` days that end the day before `beforeDate`. */
export async function loadExpenditureCheck(
  tx: HealthTransaction,
  profile: TargetProfile,
  beforeDate: string,
): Promise<ExpenditureCheck> {
  const to = addDays(beforeDate, -1);
  const from = addDays(to, -(CHECK_WINDOW_DAYS - 1));
  const series = await loadWeightSeries(tx, to);
  const intake = await loadIntake(tx, from, to);
  const days = Array.from({ length: CHECK_WINDOW_DAYS }, (_, index) => {
    const date = addDays(from, index);
    return {
      date,
      formulaKcal: maintenanceOn(profile, series, date),
      describedKcal: intake.get(date)?.describedKcal ?? 0,
      intakeKcal: intake.get(date)?.kcal ?? 0,
    };
  });
  return expenditureCheck({
    currentAdjustmentKcal: profile.expenditureAdjustmentKcal,
    days,
    weights: series.map((point) => ({ date: point.date, weightKg: point.weightKg })),
  });
}
