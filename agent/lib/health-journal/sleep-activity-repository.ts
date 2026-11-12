/**
 * Nights of sleep and daily activity of one person, typed in the chat or imported from Zepp.
 *
 * Exports:
 * - `sleepActivityRepository.execute`: log_sleep, log_activity, list, remove.
 * - `sleepActivityRepository.importZepp`: writes a parsed export (`parseZeppExport`).
 *
 * Key constructs:
 * - One night per day of waking and one activity row per day. Rewriting a night needs its version,
 *   so a screenshot never silently replaces what the person said; activity merges field by field.
 * - What the person gave in the chat wins over an import: the import refreshes only rows it wrote
 *   itself (or a day the chat gave only a pulse for) and skips the rest; weigh-ins carry the
 *   export's own UTC timestamp text as their key, independent of the session's TimeZone, so a
 *   second import of the same file adds nothing. Each kind is one set-based statement.
 */
import type { MemoryAuthorization } from "../memory-context.js";
import {
  type HealthTransaction,
  healthError,
  inputInvalid,
  notFound,
  replayable,
  requireDateRange,
  requireNotFuture,
  requireNotFutureMoment,
  staleVersion,
  withHealthTransaction,
} from "./health-access.js";
import {
  type SleepActivityInput,
  sleepActivityInput,
  sleepStartDate,
} from "./sleep-activity-input.js";
import { lastByKey, type ZeppExport } from "./zepp-export.js";

const MAX_LIST_DAYS = 31;

interface SleepRow {
  awake_min: number | null;
  bedtime: string | null;
  deep_min: number | null;
  light_min: number | null;
  rem_min: number | null;
  source: string;
  total_min: number;
  version: number;
  wake_date: string;
  wake_time: string | null;
}

interface ActivityRow {
  date: string;
  distance_m: number | null;
  resting_hr: number | null;
  source: string;
  steps: number | null;
}

function presentSleep(row: SleepRow) {
  return {
    awakeMin: row.awake_min,
    bedtime: row.bedtime,
    deepMin: row.deep_min,
    lightMin: row.light_min,
    remMin: row.rem_min,
    source: row.source,
    totalMin: row.total_min,
    version: row.version,
    wakeDate: row.wake_date,
    wakeTime: row.wake_time,
  };
}

function presentActivity(row: ActivityRow) {
  return {
    date: row.date,
    distanceM: row.distance_m,
    restingHr: row.resting_hr,
    source: row.source,
    steps: row.steps,
  };
}

const SLEEP_SELECT = `SELECT wake_date::text AS wake_date, total_min, deep_min, light_min, rem_min,
  awake_min, to_char(sleep_start AT TIME ZONE $2, 'HH24:MI') AS bedtime,
  to_char(sleep_end AT TIME ZONE $2, 'HH24:MI') AS wake_time, source, version FROM health_sleep`;
const ACTIVITY_SELECT = `SELECT local_date::text AS date, steps, distance_m, resting_hr, source
  FROM health_activity_days`;

async function logSleep(tx: HealthTransaction, input: SleepActivityInput) {
  const wakeDate = input.wakeDate ?? tx.today;
  requireNotFutureMoment(tx, wakeDate, input.wakeTime ?? "00:00", "wakeDate");
  // The night as two civil timestamps, read in the timezone below and on insert.
  const window =
    input.bedtime !== undefined && input.wakeTime !== undefined
      ? {
          end: `${wakeDate} ${input.wakeTime}`,
          start: `${sleepStartDate(wakeDate, input.bedtime, input.wakeTime)} ${input.bedtime}`,
        }
      : null;
  // The night's real length: both civil times resolved in the timezone, so a clock change counts.
  let windowMin: number | null = null;
  if (window !== null) {
    const real = await tx.client.query<{ minutes: number }>(
      `SELECT round(extract(epoch FROM ($2::timestamp AT TIME ZONE $3) - ($1::timestamp AT TIME ZONE $3)) / 60)::integer AS minutes`,
      [window.start, window.end, tx.timezone],
    );
    windowMin = real.rows[0]!.minutes;
    if (windowMin <= 0)
      throw healthError(
        "AGENT_HEALTH_INPUT_INVALID",
        "Время засыпания совпадает со временем подъёма",
        {
          category: "input",
          correction: "Уточни у человека, когда он уснул и когда проснулся.",
          field: "bedtime",
        },
      );
  }
  // Phases given as zeros (an unreadable screen) carry no total; the window or totalMin does.
  const phases = [input.deepMin, input.lightMin, input.remMin];
  const phaseSum = phases.some((item) => item !== undefined && item > 0)
    ? phases.reduce<number>((sum, item) => sum + (item ?? 0), 0)
    : null;
  const total =
    input.totalMin ?? phaseSum ?? (windowMin === null ? null : windowMin - (input.awakeMin ?? 0));
  if (total === null || total < 1 || total > 1440)
    throw healthError("AGENT_HEALTH_INPUT_INVALID", "Сон должен длиться от минуты до суток", {
      category: "input",
      correction:
        "Сверь время засыпания и подъёма, фазы и totalMin с тем, что сказал или показал человек.",
      field: "totalMin",
    });
  if (phaseSum !== null && phaseSum > total + 5)
    throw healthError("AGENT_HEALTH_INPUT_INVALID", "Фазы сна в сумме больше всего сна", {
      category: "input",
      correction: "Сверь totalMin с фазами: глубокий + лёгкий + быстрый не больше общего сна.",
      field: "totalMin",
    });
  const existing = await tx.client.query<SleepRow>(
    `${SLEEP_SELECT} WHERE owner_user_id = $1 AND wake_date = $3::date FOR UPDATE`,
    [tx.ownerUserId, tx.timezone, wakeDate],
  );
  const current = existing.rows[0];
  if (current && input.version === undefined)
    throw healthError("AGENT_HEALTH_SLEEP_EXISTS", "Сон на эту дату уже записан", {
      category: "conflict",
      correction: `Покажи человеку записанное (${current.total_min} мин, источник ${current.source}) и, если он хочет заменить, повтори с version ${current.version}.`,
    });
  if (current && current.version !== input.version) throw staleVersion("Запись сна");
  if (!current && input.version !== undefined)
    throw notFound("Запись сна", "manage_sleep_activity list");
  const values = [
    tx.ownerUserId,
    wakeDate,
    tx.familyId,
    window?.start ?? null,
    window?.end ?? null,
    tx.timezone,
    total,
    input.deepMin ?? null,
    input.lightMin ?? null,
    input.remMin ?? null,
    input.awakeMin ?? null,
    input.source,
    input.note ?? null,
  ];
  await tx.client.query(
    `INSERT INTO health_sleep (owner_user_id, wake_date, family_id, sleep_start, sleep_end, total_min,
       deep_min, light_min, rem_min, awake_min, source, note)
     VALUES ($1, $2::date, $3, $4::timestamp AT TIME ZONE $6, $5::timestamp AT TIME ZONE $6, $7,
             $8, $9, $10, $11, $12, $13)
     ON CONFLICT (owner_user_id, wake_date) DO UPDATE SET
       sleep_start = EXCLUDED.sleep_start, sleep_end = EXCLUDED.sleep_end,
       total_min = EXCLUDED.total_min, deep_min = EXCLUDED.deep_min, light_min = EXCLUDED.light_min,
       rem_min = EXCLUDED.rem_min, awake_min = EXCLUDED.awake_min, source = EXCLUDED.source,
       note = EXCLUDED.note, version = health_sleep.version + 1, updated_at = now()`,
    values,
  );
  const row = await tx.client.query<SleepRow>(
    `${SLEEP_SELECT} WHERE owner_user_id = $1 AND wake_date = $3::date`,
    [tx.ownerUserId, tx.timezone, wakeDate],
  );
  return { sleep: presentSleep(row.rows[0]!) };
}

async function logActivity(tx: HealthTransaction, input: SleepActivityInput) {
  const date = input.date ?? tx.today;
  requireNotFuture(tx, date, "date");
  await tx.client.query(
    `INSERT INTO health_activity_days (owner_user_id, local_date, family_id, steps, distance_m,
       resting_hr, source, note)
     VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (owner_user_id, local_date) DO UPDATE SET
       steps = COALESCE(EXCLUDED.steps, health_activity_days.steps),
       -- New steps without a distance leave the old distance behind: it measured the old steps.
       distance_m = CASE WHEN EXCLUDED.steps IS NOT NULL AND EXCLUDED.distance_m IS NULL THEN NULL
                         ELSE COALESCE(EXCLUDED.distance_m, health_activity_days.distance_m) END,
       resting_hr = COALESCE(EXCLUDED.resting_hr, health_activity_days.resting_hr),
       -- The source names who gave the steps: a pulse typed in the chat does not take them over.
       source = CASE WHEN EXCLUDED.steps IS NOT NULL OR EXCLUDED.distance_m IS NOT NULL
                     THEN EXCLUDED.source ELSE health_activity_days.source END,
       note = COALESCE(EXCLUDED.note, health_activity_days.note),
       version = health_activity_days.version + 1, updated_at = now()`,
    [
      tx.ownerUserId,
      date,
      tx.familyId,
      input.steps ?? null,
      input.distanceM ?? null,
      input.restingHr ?? null,
      input.source,
      input.note ?? null,
    ],
  );
  const row = await tx.client.query<ActivityRow>(
    `${ACTIVITY_SELECT} WHERE owner_user_id = $1 AND local_date = $2::date`,
    [tx.ownerUserId, date],
  );
  return { activity: presentActivity(row.rows[0]!) };
}

async function list(tx: HealthTransaction, input: SleepActivityInput) {
  const { from, to } = requireDateRange(tx, input, 7, MAX_LIST_DAYS);
  const sleep = await tx.client.query<SleepRow>(
    `${SLEEP_SELECT} WHERE owner_user_id = $1 AND wake_date BETWEEN $3::date AND $4::date ORDER BY wake_date`,
    [tx.ownerUserId, tx.timezone, from, to],
  );
  const activity = await tx.client.query<ActivityRow>(
    `${ACTIVITY_SELECT} WHERE owner_user_id = $1 AND local_date BETWEEN $2::date AND $3::date ORDER BY local_date`,
    [tx.ownerUserId, from, to],
  );
  return {
    activity: activity.rows.map(presentActivity),
    from,
    sleep: sleep.rows.map(presentSleep),
    to,
  };
}

async function importZepp(tx: HealthTransaction, data: ZeppExport, since: string | null) {
  const keep = (date: string) => date <= tx.today && (since === null || date >= since);
  // One row per key at the statement too: ON CONFLICT cannot touch one row twice.
  const activity = lastByKey(
    data.activity.filter((day) => keep(day.date)),
    (day) => day.date,
  );
  const sleep = lastByKey(
    data.sleep.filter((night) => keep(night.wakeDate)),
    (night) => night.wakeDate,
  );
  const weighed = lastByKey(data.weighIns, (entry) => entry.measuredAt);
  const activityResult = await tx.client.query<{ inserted: boolean }>(
    `INSERT INTO health_activity_days (owner_user_id, local_date, family_id, steps, distance_m, source)
     SELECT $1, day.date, $2, day.steps, day.distance, 'zepp'
       FROM unnest($3::date[], $4::integer[], $5::integer[]) AS day(date, steps, distance)
     ON CONFLICT (owner_user_id, local_date) DO UPDATE SET
       steps = EXCLUDED.steps, distance_m = EXCLUDED.distance_m, source = 'zepp',
       version = health_activity_days.version + 1, updated_at = now()
     WHERE (health_activity_days.source = 'zepp'
            OR (health_activity_days.steps IS NULL AND health_activity_days.distance_m IS NULL))
       AND (health_activity_days.steps, health_activity_days.distance_m)
           IS DISTINCT FROM (EXCLUDED.steps, EXCLUDED.distance_m)
     RETURNING (xmax = 0) AS inserted`,
    [
      tx.ownerUserId,
      tx.familyId,
      activity.map((day) => day.date),
      activity.map((day) => day.steps),
      activity.map((day) => day.distanceM),
    ],
  );
  const sleepResult = await tx.client.query<{ inserted: boolean }>(
    `INSERT INTO health_sleep (owner_user_id, wake_date, family_id, sleep_start, sleep_end, total_min,
       deep_min, light_min, rem_min, awake_min, source)
     SELECT $1, night.date, $2, night.start_at, night.end_at, night.total, night.deep, night.light,
            night.rem, night.awake, 'zepp'
       FROM unnest($3::date[], $4::timestamptz[], $5::timestamptz[], $6::integer[], $7::integer[],
                   $8::integer[], $9::integer[], $10::integer[])
            AS night(date, start_at, end_at, total, deep, light, rem, awake)
     ON CONFLICT (owner_user_id, wake_date) DO UPDATE SET
       sleep_start = EXCLUDED.sleep_start, sleep_end = EXCLUDED.sleep_end,
       total_min = EXCLUDED.total_min, deep_min = EXCLUDED.deep_min, light_min = EXCLUDED.light_min,
       rem_min = EXCLUDED.rem_min, awake_min = EXCLUDED.awake_min,
       version = health_sleep.version + 1, updated_at = now()
     WHERE health_sleep.source = 'zepp'
       AND (health_sleep.sleep_start, health_sleep.sleep_end, health_sleep.total_min,
            health_sleep.deep_min, health_sleep.light_min, health_sleep.rem_min, health_sleep.awake_min)
           IS DISTINCT FROM (EXCLUDED.sleep_start, EXCLUDED.sleep_end, EXCLUDED.total_min,
            EXCLUDED.deep_min, EXCLUDED.light_min, EXCLUDED.rem_min, EXCLUDED.awake_min)
     RETURNING (xmax = 0) AS inserted`,
    [
      tx.ownerUserId,
      tx.familyId,
      sleep.map((night) => night.wakeDate),
      sleep.map((night) => night.start),
      sleep.map((night) => night.end),
      sleep.map((night) => night.totalMin),
      sleep.map((night) => night.deepMin),
      sleep.map((night) => night.lightMin),
      sleep.map((night) => night.remMin),
      sleep.map((night) => night.awakeMin),
    ],
  );
  const weighIns = await tx.client.query<{ id: string }>(
    `INSERT INTO health_body_measurements (family_id, owner_user_id, measured_at, local_date, weight_kg,
       body_fat_pct, source, external_key)
     SELECT $1, $2, entry.at, (entry.at AT TIME ZONE $3)::date, entry.weight, entry.fat, 'zepp', entry.key
       FROM unnest($4::timestamptz[], $5::numeric[], $6::numeric[], $9::text[]) AS entry(at, weight, fat, key)
      WHERE (entry.at AT TIME ZONE $3)::date <= $7::date
        AND ($8::date IS NULL OR (entry.at AT TIME ZONE $3)::date >= $8::date)
     ON CONFLICT (owner_user_id, source, external_key) WHERE external_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      tx.familyId,
      tx.ownerUserId,
      tx.timezone,
      weighed.map((entry) => entry.measuredAt),
      weighed.map((entry) => entry.weightKg),
      weighed.map((entry) => entry.bodyFatPct),
      tx.today,
      since,
      weighed.map((entry) => entry.measuredAt),
    ],
  );
  const counted = (rows: Array<{ inserted: boolean }>, total: number) => {
    const added = rows.filter((row) => row.inserted).length;
    return { added, kept: total - rows.length, refreshed: rows.length - added };
  };
  const dates = [
    ...activity.map((day) => day.date),
    ...sleep.map((night) => night.wakeDate),
  ].sort();
  return {
    activity: counted(activityResult.rows, activity.length),
    period: dates.length === 0 ? null : { from: dates[0], to: dates.at(-1) },
    sleep: counted(sleepResult.rows, sleep.length),
    weighIns: { added: weighIns.rowCount ?? 0 },
  };
}

export const sleepActivityRepository = {
  async execute(auth: MemoryAuthorization, raw: SleepActivityInput, operationKey: string) {
    const parsed = sleepActivityInput.safeParse(raw);
    if (!parsed.success || parsed.data.action === "import_zepp")
      inputInvalid("сна или активности", "manage_sleep_activity");
    const input = parsed.data;
    return await withHealthTransaction(auth, { operationKey }, async (tx) => {
      if (input.action === "list") return await list(tx, input);
      return await replayable(tx, operationKey, input, async () => {
        if (input.action === "log_sleep") return await logSleep(tx, input);
        if (input.action === "log_activity") return await logActivity(tx, input);
        const removed =
          input.kind === "sleep"
            ? await tx.client.query(
                "DELETE FROM health_sleep WHERE owner_user_id = $1 AND wake_date = $2::date",
                [tx.ownerUserId, input.date],
              )
            : await tx.client.query(
                "DELETE FROM health_activity_days WHERE owner_user_id = $1 AND local_date = $2::date",
                [tx.ownerUserId, input.date],
              );
        if (!removed.rowCount)
          throw notFound(
            input.kind === "sleep" ? "Запись сна" : "Запись активности",
            "manage_sleep_activity list",
          );
        return { removed: { date: input.date, kind: input.kind } };
      });
    });
  },

  /** The archive is read and parsed by the caller; the operation key covers the import's input. */
  async importZepp(
    auth: MemoryAuthorization,
    input: { contentSha256: string; path: string; since: string | null },
    data: ZeppExport,
    operationKey: string,
  ) {
    return await withHealthTransaction(auth, { operationKey }, async (tx) =>
      replayable(tx, operationKey, input, async () => await importZepp(tx, data, input.since)),
    );
  },
};
