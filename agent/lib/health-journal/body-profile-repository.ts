/**
 * Body parameters, goals, targets and measurements of one person.
 *
 * Exports:
 * - `bodyProfileRepository.execute`: get (with the journal's facts), set_profile, log/list/remove
 *   measurements, apply_adjustment, erase_all and set_journal_mode.
 * - `ERASED_TABLES`: the tables `erase_all` empties for the person.
 *
 * Key constructs:
 * - Safety lives here, not in the prompt: a weight-loss goal is refused for a minor or with a
 *   deficit block (pregnancy, lactation, eating disorder, a doctor's word), and the person's own
 *   calorie target may not go below the floor (1200/1500 kcal) — nor below maintenance when a
 *   deficit is blocked.
 * - The profile is versioned; the first `set_profile` creates it without a version.
 * - `apply_adjustment` recomputes the weekly check at that moment and stores the correction only if
 *   it equals the one the person was shown.
 * - `erase_all` (approved by the person in Telegram) deletes every journal row of the person.
 */
import type { MemoryAuthorization } from "../memory-context.js";
import { type BodyProfileInput, bodyProfileInput, PROFILE_FIELDS } from "./body-profile-input.js";
import {
  ERASE_RESULT_SQL,
  type HealthTransaction,
  type JournalMode,
  healthError,
  inputInvalid,
  journalMode,
  notFound,
  numberOrNull,
  replayable,
  requireDateRange,
  stampOf,
  staleVersion,
  withHealthTransaction,
} from "./health-access.js";
import {
  ageOn,
  CALORIE_FLOOR,
  dailyTargets,
  deficitBlocked,
  plannedWeeklyRateKg,
  type TargetProfile,
} from "./health-formulas.js";
import {
  loadExpenditureCheck,
  loadProfile,
  loadWeightSeries,
  trendWeightOn,
} from "./health-state.js";

const MAX_LIST_DAYS = 180;
const LIST_LIMIT = 200;

function deficitRefused(reason: string): never {
  throw healthError("AGENT_HEALTH_DEFICIT_NOT_ALLOWED", reason, {
    category: "operation",
    correction:
      "Не ставь цель похудения. Предложи цель «держать вес» и посоветуй обсудить питание с врачом.",
    retryable: false,
  });
}

function mergeProfile(current: TargetProfile, input: BodyProfileInput): TargetProfile {
  const pick = <T>(value: T | undefined, fallback: T): T =>
    value === undefined ? fallback : value;
  return {
    activityLevel: pick(input.activityLevel, current.activityLevel),
    birthDate: pick(input.birthDate, current.birthDate),
    deficitBlock: pick(input.deficitBlock, current.deficitBlock),
    expenditureAdjustmentKcal: current.expenditureAdjustmentKcal,
    goal: pick(input.goal, current.goal),
    heightCm: pick(input.heightCm, current.heightCm),
    manual: {
      carbsG: pick(input.carbsTargetG, current.manual.carbsG),
      fatG: pick(input.fatTargetG, current.manual.fatG),
      fiberG: pick(input.fiberTargetG, current.manual.fiberG),
      kcal: pick(input.kcalTarget, current.manual.kcal),
      proteinG: pick(input.proteinTargetG, current.manual.proteinG),
      waterMl: pick(input.waterTargetMl, current.manual.waterMl),
    },
    sex: pick(input.sex, current.sex),
    weeklyRateKg: pick(input.weeklyRateKg, current.weeklyRateKg),
  };
}

function checkSafety(profile: TargetProfile, weightKg: number | null, today: string): void {
  if (profile.birthDate !== null && profile.birthDate >= today)
    throw healthError("AGENT_HEALTH_INPUT_INVALID", "Дата рождения должна быть в прошлом", {
      category: "input",
      correction: "Уточни у человека дату рождения.",
      field: "birthDate",
    });
  const blocked = deficitBlocked(profile, today);
  if (profile.goal === "lose" && blocked)
    deficitRefused(
      profile.deficitBlock === null
        ? "Цель похудения не ставится до 18 лет"
        : "Цель похудения не ставится, пока дефицит запрещён (беременность, кормление, РПП, врач)",
    );
  const kcal = profile.manual.kcal;
  if (kcal === null) return;
  // With the sex unknown the stricter floor holds.
  const floor =
    profile.sex === null
      ? Math.max(CALORIE_FLOOR.female, CALORIE_FLOOR.male)
      : CALORIE_FLOOR[profile.sex];
  if (kcal < floor)
    throw healthError("AGENT_HEALTH_TARGET_TOO_LOW", `Цель ниже ${floor} ккал в день не ставится`, {
      category: "operation",
      correction: `Не ставь цель ниже ${floor} ккал. Предложи человеку обсудить такую цель с врачом.`,
      field: "kcalTarget",
      retryable: false,
    });
  if (!blocked) return;
  // The rule of `dailyTargets`: unknown maintenance cannot vouch for the number, a known one holds it.
  const targets = dailyTargets(profile, weightKg, today);
  if (targets.maintenanceKcal === null)
    throw healthError(
      "AGENT_HEALTH_PROFILE_INCOMPLETE",
      "Пока дефицит запрещён, своя норма ставится только после расчёта поддержания",
      {
        category: "operation",
        correction:
          "Сначала сохрани пол, дату рождения, рост, активность (set_profile) и вес (log_measurement), потом своя норма.",
        retryable: false,
      },
    );
  if (targets.heldAtMaintenance)
    deficitRefused("Своя цель ниже поддержания веса не ставится, пока дефицит запрещён");
}

function presentProfile(
  stored: Awaited<ReturnType<typeof loadProfile>>,
  weightKg: number | null,
  today: string,
) {
  const profile = stored.profile;
  const targets = dailyTargets(profile, weightKg, today);
  return {
    profile: {
      activityLevel: profile.activityLevel,
      ageYears: profile.birthDate === null ? null : ageOn(profile.birthDate, today),
      birthDate: profile.birthDate,
      deficitBlock: profile.deficitBlock,
      expenditureAdjustmentKcal: profile.expenditureAdjustmentKcal,
      goal: profile.goal,
      heightCm: profile.heightCm,
      ownTargets: profile.manual,
      plannedWeeklyRateKg: weightKg === null ? null : plannedWeeklyRateKg(profile, weightKg),
      sex: profile.sex,
      version: stored.version,
      weeklyRateKg: profile.weeklyRateKg,
    },
    targets,
  };
}

async function currentWeight(tx: HealthTransaction) {
  const series = await loadWeightSeries(tx, tx.today);
  const last = series.at(-1) ?? null;
  return {
    latest:
      last === null ? null : { date: last.date, trendKg: last.trendKg, weightKg: last.weightKg },
    trendKg: trendWeightOn(series, tx.today),
  };
}

interface MeasurementRow {
  body_fat_pct: string | null;
  date: string;
  id: string;
  muscle_pct: string | null;
  note: string | null;
  source: string;
  time: string;
  waist_cm: string | null;
  weight_kg: string | null;
}

function presentMeasurement(row: MeasurementRow) {
  return {
    bodyFatPct: numberOrNull(row.body_fat_pct),
    date: row.date,
    id: row.id,
    musclePct: numberOrNull(row.muscle_pct),
    note: row.note,
    source: row.source,
    time: row.time,
    waistCm: numberOrNull(row.waist_cm),
    weightKg: numberOrNull(row.weight_kg),
  };
}

const MEASUREMENT_SELECT = `SELECT id, local_date::text AS date,
  to_char(measured_at AT TIME ZONE $2, 'HH24:MI') AS time, weight_kg, body_fat_pct, muscle_pct,
  waist_cm, source, note FROM health_body_measurements`;

async function setProfile(tx: HealthTransaction, input: BodyProfileInput) {
  const stored = await loadProfile(tx, true);
  if ((stored.version ?? undefined) !== input.version) {
    if (stored.version === null)
      throw healthError("AGENT_HEALTH_INPUT_INVALID", "Профиля ещё нет, version не нужна", {
        category: "input",
        correction: "Повтори set_profile без version.",
        field: "version",
      });
    throw staleVersion("Профиль");
  }
  // Lifting a deficit block is its own step, never part of the call that changes the goal or the
  // target: the person says it plainly, and only then the goal can follow.
  const lifting = input.deficitBlock === null && stored.profile.deficitBlock !== null;
  if (
    lifting &&
    Object.keys(input).some((field) => !["action", "deficitBlock", "version"].includes(field))
  )
    deficitRefused("Запрет дефицита снимается отдельным шагом, не вместе с целью или нормой");
  const merged = mergeProfile(stored.profile, input);
  const weight = await currentWeight(tx);
  checkSafety(merged, weight.trendKg, tx.today);
  const columns = Object.entries(PROFILE_FIELDS).filter(([key]) => key in input);
  const values = columns.map(([key]) => input[key as keyof BodyProfileInput] ?? null);
  const names = columns.map(([, column]) => column);
  const placeholders = names.map((_, index) => `$${index + 3}`);
  await tx.client.query(
    `INSERT INTO health_profiles (owner_user_id, family_id${names.map((name) => `, ${name}`).join("")})
     VALUES ($1, $2${placeholders.map((p) => `, ${p}`).join("")})
     ON CONFLICT (owner_user_id) DO UPDATE SET
       ${[...names.map((name) => `${name} = EXCLUDED.${name}`), "version = health_profiles.version + 1", "updated_at = now()"].join(", ")}`,
    [tx.ownerUserId, tx.familyId, ...values],
  );
  const result = presentProfile(await loadProfile(tx), weight.trendKg, tx.today);
  // The person's own number below resting expenditure is their decision; Mia says what it means.
  const own = merged.manual.kcal;
  const bmr = result.targets.bmrKcal;
  const warnings =
    own !== null && bmr !== null && own < bmr && !result.targets.heldAtMaintenance
      ? [
          `Своя норма ${own} ккал ниже обмена в покое (≈${bmr} ккал): так худеют быстрее, но легче потерять мышцы и сорваться. Скажи об этом человеку одной фразой.`,
        ]
      : [];
  return { ...result, warnings };
}

async function applyAdjustment(tx: HealthTransaction, input: BodyProfileInput) {
  const stored = await loadProfile(tx, true);
  if (stored.version === null) throw notFound("Профиль", "manage_body_profile get");
  if (stored.version !== input.version) throw staleVersion("Профиль");
  const check = await loadExpenditureCheck(tx, stored.profile, tx.today);
  if (check.status !== "ok" || check.proposedAdjustmentKcal !== input.adjustmentKcal)
    throw healthError(
      "AGENT_HEALTH_ADJUSTMENT_STALE",
      "Недельная сверка сейчас предлагает другую поправку или не предлагает её",
      {
        category: "conflict",
        correction:
          "Вызови health_summary week, покажи человеку актуальное предложение и примени только его число после согласия.",
      },
    );
  await tx.client.query(
    `UPDATE health_profiles SET expenditure_adjustment_kcal = $2, adjustment_applied_at = now(),
            version = version + 1, updated_at = now() WHERE owner_user_id = $1`,
    [tx.ownerUserId, input.adjustmentKcal],
  );
  const weight = await currentWeight(tx);
  return presentProfile(await loadProfile(tx), weight.trendKg, tx.today);
}

/** Every journal table with an owner; sets go with their workouts. A test checks it against the schema. */
export const ERASED_TABLES = [
  "health_food_entries",
  "health_body_measurements",
  "health_sleep",
  "health_activity_days",
  "health_workouts",
  "health_profiles",
] as const;

/**
 * Runs inside `replayable`, under the person's lock: a replay of this call returns its counts, and
 * a replay of any earlier write finds its key marked erased instead of writing the data again. The
 * journal keeps only call ids and input hashes, no health data.
 */
async function eraseAll(tx: HealthTransaction) {
  // The mode is where the person keeps the journal, not a record of it: it outlives the erase.
  const mode = await journalMode(tx.client, tx.ownerUserId);
  const counts: Record<string, number> = {};
  for (const table of ERASED_TABLES) {
    const result = await tx.client.query(`DELETE FROM ${table} WHERE owner_user_id = $1`, [
      tx.ownerUserId,
    ]);
    counts[table] = result.rowCount ?? 0;
  }
  if (mode !== "database") await saveJournalMode(tx, mode);
  await tx.client.query(
    // Earlier erases keep their counts: they are what `journalState` counts, and it must only grow.
    `UPDATE health_operations SET result = '{"erased": true}'::jsonb
      WHERE owner_user_id = $1 AND NOT (${ERASE_RESULT_SQL})`,
    [tx.ownerUserId],
  );
  return { erased: counts };
}

/**
 * What the journal knows about itself, so «was it erased» is a fact: its mode, its first write
 * since the last erase, and its erases. An empty journal with no erase was never written to.
 * The first write comes from the journal of operations, not from the records left: a write whose
 * record was removed later was still made. An erase marks every earlier write `{"erased": true}`,
 * so the writes not marked are those since the last erase; a mode switch is not a write.
 */
async function journalFacts(tx: HealthTransaction) {
  // One pass over the person's operations.
  const result = await tx.client.query<{
    erases: number;
    first_record: string | null;
    last_erased: string | null;
  }>(
    `SELECT to_char(min(created_at) FILTER (WHERE NOT (result ? 'erased' OR result ? 'journal'))
                      AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI') AS first_record,
            count(*) FILTER (WHERE ${ERASE_RESULT_SQL})::integer AS erases,
            to_char(max(created_at) FILTER (WHERE ${ERASE_RESULT_SQL})
                      AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI') AS last_erased
       FROM health_operations WHERE owner_user_id = $1`,
    [tx.ownerUserId, tx.timezone],
  );
  const row = result.rows[0]!;
  return {
    erases: row.erases,
    firstWriteAt: row.first_record,
    lastErasedAt: row.last_erased,
    mode: await journalMode(tx.client, tx.ownerUserId),
  };
}

/** Where the person keeps the journal; it lives in the profile row and creates one if needed. */
async function saveJournalMode(tx: HealthTransaction, mode: JournalMode): Promise<void> {
  await tx.client.query(
    `INSERT INTO health_profiles (owner_user_id, family_id, journal_mode) VALUES ($1, $2, $3)
     ON CONFLICT (owner_user_id) DO UPDATE SET journal_mode = EXCLUDED.journal_mode,
       version = health_profiles.version + 1, updated_at = now()`,
    [tx.ownerUserId, tx.familyId, mode],
  );
}

export const bodyProfileRepository = {
  async execute(auth: MemoryAuthorization, raw: BodyProfileInput, operationKey: string) {
    const parsed = bodyProfileInput.safeParse(raw);
    if (!parsed.success) inputInvalid("профиля или замера", "manage_body_profile");
    const input = parsed.data;
    // The journal's facts, the mode switch and erasing the database copies work in both modes.
    const anyMode = ["get", "set_journal_mode", "erase_all"].includes(input.action);
    return await withHealthTransaction(auth, { anyMode, operationKey }, async (tx) => {
      if (input.action === "get") {
        // A person keeping files gets no numbers from the database copies, only where they are.
        const journal = await journalFacts(tx);
        if (journal.mode === "files") return { journal };
        const weight = await currentWeight(tx);
        return {
          ...presentProfile(await loadProfile(tx), weight.trendKg, tx.today),
          journal,
          latestWeight: weight.latest,
        };
      }
      if (input.action === "list_measurements") {
        const { from, to } = requireDateRange(tx, input, 30, MAX_LIST_DAYS);
        const rows = await tx.client.query<MeasurementRow>(
          `${MEASUREMENT_SELECT} WHERE owner_user_id = $1 AND removed_at IS NULL
             AND local_date BETWEEN $3::date AND $4::date ORDER BY measured_at DESC LIMIT ${LIST_LIMIT + 1}`,
          [tx.ownerUserId, tx.timezone, from, to],
        );
        return {
          from,
          hasMore: rows.rows.length > LIST_LIMIT,
          measurements: rows.rows.slice(0, LIST_LIMIT).map(presentMeasurement),
          to,
        };
      }
      return await replayable(tx, operationKey, input, async () => {
        if (input.action === "erase_all") return await eraseAll(tx);
        if (input.action === "set_journal_mode") {
          await saveJournalMode(tx, input.journalMode!);
          return { journal: await journalFacts(tx) };
        }
        if (input.action === "set_profile") return await setProfile(tx, input);
        if (input.action === "apply_adjustment") return await applyAdjustment(tx, input);
        if (input.action === "remove_measurement") {
          const removed = await tx.client.query<MeasurementRow>(
            `UPDATE health_body_measurements SET removed_at = now()
              WHERE id = $1 AND owner_user_id = $2 AND removed_at IS NULL RETURNING id`,
            [input.id, tx.ownerUserId],
          );
          if (!removed.rowCount)
            throw notFound("Запись замера", "manage_body_profile list_measurements");
          return { removed: { id: input.id } };
        }
        const { date, time } = stampOf(tx, input.date, input.time);
        const inserted = await tx.client.query<{ id: string }>(
          `INSERT INTO health_body_measurements
             (family_id, owner_user_id, measured_at, local_date, weight_kg, body_fat_pct, muscle_pct,
              waist_cm, source, note)
           VALUES ($1, $2, ($3::date + $4::time) AT TIME ZONE $5, $3::date, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [
            tx.familyId,
            tx.ownerUserId,
            date,
            time,
            tx.timezone,
            input.weightKg ?? null,
            input.bodyFatPct ?? null,
            input.musclePct ?? null,
            input.waistCm ?? null,
            input.source,
            input.note ?? null,
          ],
        );
        const row = await tx.client.query<MeasurementRow>(`${MEASUREMENT_SELECT} WHERE id = $1`, [
          inserted.rows[0]!.id,
          tx.timezone,
        ]);
        const weight = await currentWeight(tx);
        return { measurement: presentMeasurement(row.rows[0]!), trendKg: weight.trendKg };
      });
    });
  },
};
