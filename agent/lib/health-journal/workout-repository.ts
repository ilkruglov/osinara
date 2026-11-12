/**
 * Workouts of one person: strength sessions with their sets, and cardio, sport or mobility by time.
 *
 * Exports:
 * - `workoutRepository.execute`: add, get, update, remove, list and an exercise's progress.
 *
 * Key constructs:
 * - Sets are rows, so an exercise's history and records are SQL over every workout; its key is the
 *   normalized name (`normalizeExerciseKey`), so «Жим лёжа» and «жим лежа» are one exercise.
 * - Tonnage and set count are computed here and stored on the workout.
 * - `update` replaces the sets only when `exercises` is given.
 */
import type { MemoryAuthorization } from "../memory-context.js";
import {
  type HealthTransaction,
  healthError,
  inputInvalid,
  notFound,
  numberOrNull,
  replayable,
  requireDateRange,
  requireNotFutureMoment,
  stampOf,
  staleVersion,
  withHealthTransaction,
} from "./health-access.js";
import { normalizeExerciseKey, workoutLoad } from "./health-formulas.js";
import { type ExerciseInput, type WorkoutInput, workoutInput } from "./workout-input.js";

const MAX_LIST_DAYS = 62;
const PROGRESS_LIMIT = 30;
const LIST_LIMIT = 100;

interface WorkoutRow {
  date: string;
  duration_min: number;
  id: string;
  intensity: string;
  kind: string;
  note: string | null;
  set_count: number;
  time: string;
  title: string;
  tonnage_kg: string;
  version: number;
}

interface SetRow {
  duration_s: number | null;
  exercise: string;
  reps: number | null;
  weight_kg: string | null;
  workout_id: string;
}

const SELECT = `SELECT id, local_date::text AS date, to_char(started_at AT TIME ZONE $2, 'HH24:MI') AS time,
  kind, title, duration_min, intensity, tonnage_kg, set_count, note, version FROM health_workouts`;

function present(row: WorkoutRow, sets?: SetRow[]) {
  const exercises: Array<{ name: string; sets: Array<Record<string, number>> }> = [];
  for (const set of sets ?? []) {
    let last = exercises.at(-1);
    if (!last || last.name !== set.exercise) {
      last = { name: set.exercise, sets: [] };
      exercises.push(last);
    }
    last.sets.push({
      ...(set.weight_kg === null ? {} : { weightKg: Number(set.weight_kg) }),
      ...(set.reps === null ? {} : { reps: set.reps }),
      ...(set.duration_s === null ? {} : { durationS: set.duration_s }),
    });
  }
  return {
    date: row.date,
    durationMin: row.duration_min,
    id: row.id,
    intensity: row.intensity,
    kind: row.kind,
    note: row.note,
    setCount: row.set_count,
    time: row.time,
    title: row.title,
    tonnageKg: Number(row.tonnage_kg),
    version: row.version,
    ...(sets === undefined ? {} : { exercises }),
  };
}

async function selectWorkout(tx: HealthTransaction, id: string, lock: boolean) {
  const result = await tx.client.query<WorkoutRow>(
    `${SELECT} WHERE id = $1 AND owner_user_id = $3 AND removed_at IS NULL${lock ? " FOR UPDATE" : ""}`,
    [id, tx.timezone, tx.ownerUserId],
  );
  return result.rows[0] ?? null;
}

async function selectSets(tx: HealthTransaction, workoutId: string): Promise<SetRow[]> {
  const result = await tx.client.query<SetRow>(
    `SELECT workout_id, exercise, weight_kg, reps, duration_s FROM health_workout_sets
      WHERE workout_id = $1 ORDER BY position`,
    [workoutId],
  );
  return result.rows;
}

function flattenSets(exercises: readonly ExerciseInput[]) {
  const flat = exercises.flatMap((exercise) =>
    exercise.sets.map((set) => ({
      ...set,
      key: normalizeExerciseKey(exercise.name),
      name: exercise.name,
    })),
  );
  const load = workoutLoad(
    flat.map((set) => ({ reps: set.reps ?? null, weightKg: set.weightKg ?? null })),
  );
  return { flat, load };
}

/** Replaces a workout's sets; a new workout has none to delete. */
async function writeSets(
  tx: HealthTransaction,
  workoutId: string,
  flat: ReturnType<typeof flattenSets>["flat"],
  replace: boolean,
) {
  if (replace)
    await tx.client.query("DELETE FROM health_workout_sets WHERE workout_id = $1", [workoutId]);
  if (flat.length > 0)
    await tx.client.query(
      `INSERT INTO health_workout_sets (workout_id, position, exercise, exercise_key, weight_kg, reps, duration_s)
       SELECT $1, set_row.position, set_row.exercise, set_row.key, set_row.weight, set_row.reps, set_row.duration
         FROM unnest($2::integer[], $3::text[], $4::text[], $5::numeric[], $6::integer[], $7::integer[])
              AS set_row(position, exercise, key, weight, reps, duration)`,
      [
        workoutId,
        flat.map((_, index) => index + 1),
        flat.map((set) => set.name),
        flat.map((set) => set.key),
        flat.map((set) => set.weightKg ?? null),
        flat.map((set) => set.reps ?? null),
        flat.map((set) => set.durationS ?? null),
      ],
    );
}

/**
 * An exercise's last `PROGRESS_LIMIT` workouts, and its records over the whole history. The best
 * reps of a workout are those at its top weight; with no weight at all, the most reps of a set.
 */
async function progress(tx: HealthTransaction, exercise: string) {
  const key = normalizeExerciseKey(exercise);
  const result = await tx.client.query<{
    best_reps: number | null;
    date: string;
    max_weight: string | null;
    name: string;
    sets: number;
    tonnage: string;
  }>(
    `WITH per_workout AS (
       SELECT w.id, w.local_date, w.started_at, s.exercise, s.weight_kg, s.reps,
              max(s.weight_kg) OVER (PARTITION BY w.id) AS top_weight
         FROM health_workouts w JOIN health_workout_sets s ON s.workout_id = w.id
        WHERE w.owner_user_id = $1 AND w.removed_at IS NULL AND s.exercise_key = $2)
     SELECT local_date::text AS date, min(exercise) AS name, count(*)::integer AS sets,
            max(weight_kg)::text AS max_weight,
            max(reps) FILTER (WHERE weight_kg IS NOT DISTINCT FROM top_weight) AS best_reps,
            coalesce(sum(weight_kg * reps), 0)::text AS tonnage
       FROM per_workout
      GROUP BY id, local_date, started_at ORDER BY local_date DESC, started_at DESC
      LIMIT ${PROGRESS_LIMIT}`,
    [tx.ownerUserId, key],
  );
  if (result.rows.length === 0)
    throw healthError(
      "AGENT_HEALTH_EXERCISE_NOT_FOUND",
      `Упражнения «${exercise}» в дневнике нет`,
      {
        category: "not_found",
        correction:
          "Посмотри названия упражнений через manage_workouts list и get и повтори с точным названием.",
      },
    );
  const records = await tx.client.query<{ tonnage: string | null; weight: string | null }>(
    `SELECT max(top.weight)::text AS weight, max(top.tonnage)::text AS tonnage
       FROM (SELECT max(s.weight_kg) AS weight, sum(s.weight_kg * s.reps) AS tonnage
               FROM health_workouts w JOIN health_workout_sets s ON s.workout_id = w.id
              WHERE w.owner_user_id = $1 AND w.removed_at IS NULL AND s.exercise_key = $2
              GROUP BY w.id) AS top`,
    [tx.ownerUserId, key],
  );
  const record = records.rows[0]!;
  return {
    exercise: result.rows[0]!.name,
    history: result.rows.map((row) => ({
      bestReps: row.best_reps,
      date: row.date,
      maxWeightKg: numberOrNull(row.max_weight),
      sets: row.sets,
      tonnageKg: Number(row.tonnage),
    })),
    recordTonnageKg: record.tonnage === null ? 0 : Number(record.tonnage),
    recordWeightKg: numberOrNull(record.weight),
  };
}

export const workoutRepository = {
  async execute(auth: MemoryAuthorization, raw: WorkoutInput, operationKey: string) {
    const parsed = workoutInput.safeParse(raw);
    if (!parsed.success) inputInvalid("тренировки", "manage_workouts");
    const input = parsed.data;
    return await withHealthTransaction(auth, { operationKey }, async (tx) => {
      if (input.action === "progress") return await progress(tx, input.exercise!);
      if (input.action === "list") {
        const { from, to } = requireDateRange(tx, input, 14, MAX_LIST_DAYS);
        const rows = await tx.client.query<WorkoutRow>(
          `${SELECT} WHERE owner_user_id = $1 AND removed_at IS NULL
             AND local_date BETWEEN $3::date AND $4::date ORDER BY started_at LIMIT ${LIST_LIMIT + 1}`,
          [tx.ownerUserId, tx.timezone, from, to],
        );
        return {
          from,
          hasMore: rows.rows.length > LIST_LIMIT,
          to,
          workouts: rows.rows.slice(0, LIST_LIMIT).map((row) => present(row)),
        };
      }
      if (input.action === "get") {
        const row = await selectWorkout(tx, input.id!, false);
        if (!row) throw notFound("Тренировка", "manage_workouts list");
        return { workout: present(row, await selectSets(tx, row.id)) };
      }
      return await replayable(tx, operationKey, input, async () => {
        if (input.action === "add") {
          const { date, time } = stampOf(tx, input.date, input.time);
          const { flat, load } = flattenSets(input.exercises ?? []);
          const inserted = await tx.client.query<{ id: string }>(
            `INSERT INTO health_workouts (family_id, owner_user_id, started_at, local_date, kind, title,
               duration_min, intensity, note, tonnage_kg, set_count)
             VALUES ($1, $2, ($3::date + $4::time) AT TIME ZONE $5, $3::date, $6, $7, $8, $9, $10, $11, $12)
             RETURNING id`,
            [
              tx.familyId,
              tx.ownerUserId,
              date,
              time,
              tx.timezone,
              input.kind,
              input.title,
              input.durationMin,
              input.intensity,
              input.note ?? null,
              load.tonnageKg,
              load.setCount,
            ],
          );
          const id = inserted.rows[0]!.id;
          await writeSets(tx, id, flat, false);
          const row = await selectWorkout(tx, id, false);
          return { workout: present(row!, await selectSets(tx, id)) };
        }
        const current = await selectWorkout(tx, input.id!, true);
        if (!current) throw notFound("Тренировка", "manage_workouts list");
        if (current.version !== input.version) throw staleVersion("Тренировка");
        if (input.action === "remove") {
          await tx.client.query(
            "UPDATE health_workouts SET removed_at = now(), version = version + 1, updated_at = now() WHERE id = $1",
            [current.id],
          );
          return { removed: { id: current.id, title: current.title } };
        }
        const date = input.date ?? current.date;
        requireNotFutureMoment(tx, date, input.time ?? current.time, "date");
        let load = { setCount: current.set_count, tonnageKg: Number(current.tonnage_kg) };
        if (input.exercises !== undefined) {
          const sets = flattenSets(input.exercises);
          await writeSets(tx, current.id, sets.flat, true);
          load = sets.load;
        }
        await tx.client.query(
          `UPDATE health_workouts
              SET started_at = CASE WHEN $12 THEN ($2::date + $3::time) AT TIME ZONE $4 ELSE started_at END,
                  local_date = CASE WHEN $12 THEN $2::date ELSE local_date END, kind = $5,
                  title = $6, duration_min = $7, intensity = $8, note = $9, tonnage_kg = $10,
                  set_count = $11, version = version + 1, updated_at = now()
            WHERE id = $1`,
          [
            current.id,
            date,
            input.time ?? current.time,
            tx.timezone,
            input.kind ?? current.kind,
            input.title ?? current.title,
            input.durationMin ?? current.duration_min,
            input.intensity ?? current.intensity,
            input.note === undefined ? current.note : input.note,
            load.tonnageKg,
            load.setCount,
            // Only a new date or time moves the workout: an untouched one keeps its moment.
            input.date !== undefined || input.time !== undefined,
          ],
        );
        const row = await selectWorkout(tx, current.id, false);
        return { workout: present(row!, await selectSets(tx, current.id)) };
      });
    });
  },
};
