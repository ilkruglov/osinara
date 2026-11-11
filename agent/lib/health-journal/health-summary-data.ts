/**
 * The numbers of a day and of a week, computed from the journal.
 *
 * Exports:
 * - `loadDaySummary`, `DaySummary`: food, water, targets, expenditure and balance, sleep, activity,
 *   workouts and weight of one civil day.
 * - `loadWeekSummary`, `WeekSummary`: seven days ending on a date, averages over logged days, the
 *   weight trend, sleep and load, and the weekly expenditure check.
 *
 * Key construct: everything the cards and the evening text show comes from here, so a number in
 * a card is always the number in the database, not one the model retyped.
 */
import type { ExpenditureCheck } from "./expenditure-check.js";
import type { HealthTransaction } from "./health-access.js";
import {
  addDays,
  dailyTargets,
  type DailyTargets,
  type Expenditure,
  round,
} from "./health-formulas.js";
import {
  expenditureOn,
  loadActivity,
  loadExpenditureCheck,
  loadProfile,
  loadWeightSeries,
  trendWeightOn,
} from "./health-state.js";

export interface MealLine {
  approximate: boolean;
  kcal: number;
  time: string;
  title: string;
}

export interface NutritionTotals {
  carbs: number;
  fat: number;
  fiber: number;
  kcal: number;
  protein: number;
  waterMl: number;
}

export interface SleepLine {
  bedtime: string | null;
  totalMin: number;
  wakeTime: string | null;
}

export interface WorkoutLine {
  durationMin: number;
  kind: string;
  title: string;
  tonnageKg: number;
}

export interface DaySummary {
  activity: { distanceM: number | null; restingHr: number | null; steps: number | null } | null;
  balanceKcal: number | null;
  date: string;
  eaten: NutritionTotals;
  expenditure: Expenditure | null;
  isToday: boolean;
  meals: MealLine[];
  remainingKcal: number | null;
  sleep: SleepLine | null;
  targets: DailyTargets;
  weight: { trendKg: number | null; weighedKg: number | null };
  workouts: WorkoutLine[];
}

const MEAL_LIMIT = 60;
const WORKOUT_LIMIT = 10;

async function nutritionByDay(tx: HealthTransaction, from: string, to: string) {
  const result = await tx.client.query<{
    carbs: string;
    date: string;
    fat: string;
    fiber: string;
    kcal: string;
    protein: string;
    water: string;
  }>(
    `SELECT local_date::text AS date, sum(kcal)::text AS kcal, sum(protein_g)::text AS protein,
            sum(fat_g)::text AS fat, sum(carbs_g)::text AS carbs, sum(fiber_g)::text AS fiber,
            sum(water_ml)::text AS water
       FROM health_food_entries
      WHERE owner_user_id = $1 AND removed_at IS NULL AND local_date BETWEEN $2::date AND $3::date
      GROUP BY local_date`,
    [tx.ownerUserId, from, to],
  );
  return new Map<string, NutritionTotals>(
    result.rows.map((row) => [
      row.date,
      {
        carbs: round(Number(row.carbs), 1),
        fat: round(Number(row.fat), 1),
        fiber: round(Number(row.fiber), 1),
        kcal: Math.round(Number(row.kcal)),
        protein: round(Number(row.protein), 1),
        waterMl: Number(row.water),
      },
    ]),
  );
}

const EMPTY_TOTALS: NutritionTotals = {
  carbs: 0,
  fat: 0,
  fiber: 0,
  kcal: 0,
  protein: 0,
  waterMl: 0,
};

async function sleepByDay(tx: HealthTransaction, from: string, to: string) {
  const result = await tx.client.query<{
    bedtime: string | null;
    date: string;
    total_min: number;
    wake_time: string | null;
  }>(
    `SELECT wake_date::text AS date, total_min,
            to_char(sleep_start AT TIME ZONE $4, 'HH24:MI') AS bedtime,
            to_char(sleep_end AT TIME ZONE $4, 'HH24:MI') AS wake_time
       FROM health_sleep WHERE owner_user_id = $1 AND wake_date BETWEEN $2::date AND $3::date`,
    [tx.ownerUserId, from, to, tx.timezone],
  );
  return new Map<string, SleepLine>(
    result.rows.map((row) => [
      row.date,
      { bedtime: row.bedtime, totalMin: row.total_min, wakeTime: row.wake_time },
    ]),
  );
}

export async function loadDaySummary(tx: HealthTransaction, date: string): Promise<DaySummary> {
  const { profile } = await loadProfile(tx);
  const series = await loadWeightSeries(tx, date);
  const trendKg = trendWeightOn(series, date);
  const targets = dailyTargets(profile, trendKg, date);
  const eaten = (await nutritionByDay(tx, date, date)).get(date) ?? EMPTY_TOTALS;
  const meals = await tx.client.query<{
    estimate_source: string;
    kcal: string;
    time: string;
    title: string;
  }>(
    `SELECT to_char(eaten_at AT TIME ZONE $3, 'HH24:MI') AS time, title, kcal, estimate_source
       FROM health_food_entries
      WHERE owner_user_id = $1 AND local_date = $2::date AND removed_at IS NULL
      ORDER BY eaten_at, created_at LIMIT ${MEAL_LIMIT}`,
    [tx.ownerUserId, date, tx.timezone],
  );
  const dayActivity = (await loadActivity(tx, date, date)).get(date);
  const expenditure = expenditureOn(profile, series, dayActivity, date);
  const workouts = await tx.client.query<{
    duration_min: number;
    kind: string;
    title: string;
    tonnage_kg: string;
  }>(
    `SELECT title, kind, duration_min, tonnage_kg FROM health_workouts
      WHERE owner_user_id = $1 AND local_date = $2::date AND removed_at IS NULL
      ORDER BY started_at LIMIT ${WORKOUT_LIMIT}`,
    [tx.ownerUserId, date],
  );
  const weighed = series.find((point) => point.date === date)?.weightKg ?? null;
  const recorded =
    dayActivity !== undefined &&
    (dayActivity.steps !== null ||
      dayActivity.distanceM !== null ||
      dayActivity.restingHr !== null);
  return {
    activity: recorded
      ? {
          distanceM: dayActivity.distanceM,
          restingHr: dayActivity.restingHr,
          steps: dayActivity.steps,
        }
      : null,
    balanceKcal: expenditure === null ? null : eaten.kcal - expenditure.totalKcal,
    date,
    eaten,
    expenditure,
    isToday: date === tx.today,
    meals: meals.rows.map((row) => ({
      approximate: row.estimate_source === "photo" || row.estimate_source === "described",
      kcal: Math.round(Number(row.kcal)),
      time: row.time,
      title: row.title,
    })),
    remainingKcal: targets.kcal === null ? null : targets.kcal - eaten.kcal,
    sleep: (await sleepByDay(tx, date, date)).get(date) ?? null,
    targets,
    weight: { trendKg, weighedKg: weighed },
    workouts: workouts.rows.map((row) => ({
      durationMin: row.duration_min,
      kind: row.kind,
      title: row.title,
      tonnageKg: Number(row.tonnage_kg),
    })),
  };
}

export interface WeekDay {
  date: string;
  eatenKcal: number | null;
  expenditureKcal: number | null;
  sleepMin: number | null;
  steps: number | null;
  targetKcal: number | null;
  workouts: number;
}

export interface WeekSummary {
  averages: {
    expenditureKcal: number | null;
    fiberG: number | null;
    kcal: number | null;
    proteinG: number | null;
    sleepMin: number | null;
    steps: number | null;
    waterMl: number | null;
  };
  check: ExpenditureCheck;
  days: WeekDay[];
  from: string;
  loggedDays: number;
  /** Logged days within 10 % of their calorie target. */
  onTargetDays: number;
  targets: DailyTargets;
  to: string;
  weight: {
    changeKg: number | null;
    points: Array<{ date: string; trendKg: number; weightKg: number }>;
    trendKg: number | null;
  };
  workouts: { count: number; minutes: number; tonnageKg: number };
}

const average = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

export async function loadWeekSummary(tx: HealthTransaction, to: string): Promise<WeekSummary> {
  const from = addDays(to, -6);
  const { profile } = await loadProfile(tx);
  const series = await loadWeightSeries(tx, to);
  const nutrition = await nutritionByDay(tx, from, to);
  const sleep = await sleepByDay(tx, from, to);
  const activity = await loadActivity(tx, from, to);
  const days: WeekDay[] = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(from, index);
    const day = activity.get(date);
    return {
      date,
      eatenKcal: nutrition.get(date)?.kcal ?? null,
      expenditureKcal: expenditureOn(profile, series, day, date)?.totalKcal ?? null,
      sleepMin: sleep.get(date)?.totalMin ?? null,
      steps: day?.steps ?? null,
      targetKcal: dailyTargets(profile, trendWeightOn(series, date), date).kcal,
      workouts: day?.workouts.length ?? 0,
    };
  });
  const logged = days.filter((day) => day.eatenKcal !== null);
  const loggedTotals = logged.map((day) => nutrition.get(day.date)!);
  const workouts = await tx.client.query<{ count: number; minutes: number; tonnage: string }>(
    `SELECT count(*)::integer AS count, coalesce(sum(duration_min), 0)::integer AS minutes,
            coalesce(sum(tonnage_kg), 0)::text AS tonnage
       FROM health_workouts
      WHERE owner_user_id = $1 AND removed_at IS NULL AND local_date BETWEEN $2::date AND $3::date`,
    [tx.ownerUserId, from, to],
  );
  const recent = series.filter((point) => point.date >= addDays(to, -13));
  const startTrend = trendWeightOn(series, addDays(from, -1)) ?? recent[0]?.trendKg ?? null;
  const endTrend = trendWeightOn(series, to);
  const pick = (values: Array<number | null>) =>
    values.filter((value): value is number => value !== null);
  const roundOrNull = (value: number | null, digits = 0) =>
    value === null ? null : round(value, digits);
  const targets = dailyTargets(profile, endTrend, to);
  return {
    averages: {
      expenditureKcal: roundOrNull(average(pick(days.map((day) => day.expenditureKcal)))),
      fiberG: roundOrNull(average(loggedTotals.map((day) => day.fiber))),
      kcal: roundOrNull(average(logged.map((day) => day.eatenKcal!))),
      proteinG: roundOrNull(average(loggedTotals.map((day) => day.protein))),
      sleepMin: roundOrNull(average(pick(days.map((day) => day.sleepMin)))),
      steps: roundOrNull(average(pick(days.map((day) => day.steps)))),
      waterMl: roundOrNull(average(loggedTotals.map((day) => day.waterMl))),
    },
    // The check is about now, whatever week is shown: `apply_adjustment` recomputes the same one.
    check: await loadExpenditureCheck(tx, profile, tx.today),
    days,
    from,
    loggedDays: logged.length,
    onTargetDays: logged.filter(
      (day) =>
        day.targetKcal !== null &&
        Math.abs(day.eatenKcal! - day.targetKcal) <= day.targetKcal * 0.1,
    ).length,
    targets,
    to,
    weight: {
      changeKg:
        startTrend === null || endTrend === null || recent.length < 2
          ? null
          : round(endTrend - startTrend, 1),
      points: recent,
      trendKg: endTrend,
    },
    workouts: {
      count: workouts.rows[0]!.count,
      minutes: workouts.rows[0]!.minutes,
      tonnageKg: Number(workouts.rows[0]!.tonnage),
    },
  };
}
