/**
 * The food and drink journal of one person.
 *
 * Exports:
 * - `foodLogRepository.execute`: add, get, update, remove and the day's list with totals.
 *
 * Key constructs:
 * - Totals are computed from the composition (`foodEntryTotals`) and stored beside it, so day sums
 *   are plain SQL and never a sum the model wrote.
 * - An entry's day is the person's civil date of the meal; a time given without a date means today.
 * - `version` guards edits; removal is soft, so an accidental removal can be restored by hand.
 * - Writes replay by Eve call id (`replayable`).
 */
import type { MemoryAuthorization } from "../memory-context.js";
import {
  type HealthTransaction,
  inputInvalid,
  notFound,
  replayable,
  requireNotFutureMoment,
  stampOf,
  staleVersion,
  withHealthTransaction,
} from "./health-access.js";
import { round } from "./health-formulas.js";
import {
  type FoodItemInput,
  type FoodLogInput,
  foodEntryTotals,
  foodItemTotals,
  foodLogInput,
} from "./food-log-input.js";

interface FoodRow {
  carbs_g: string;
  date: string;
  estimate_source: FoodEntry["estimateSource"];
  fat_g: string;
  fiber_g: string;
  id: string;
  items: FoodItemInput[];
  kcal: string;
  note: string | null;
  protein_g: string;
  time: string;
  title: string;
  version: number;
  water_ml: number;
}

interface FoodEntry {
  carbs: number;
  date: string;
  estimateSource: "described" | "label" | "photo" | "weighed";
  fat: number;
  fiber: number;
  id: string;
  items: Array<Record<string, unknown>>;
  kcal: number;
  note: string | null;
  protein: number;
  time: string;
  title: string;
  version: number;
  waterMl: number;
}

const DAY_ENTRY_LIMIT = 60;

function present(row: FoodRow, detail: "compact" | "full"): FoodEntry {
  return {
    carbs: Number(row.carbs_g),
    date: row.date,
    estimateSource: row.estimate_source,
    fat: Number(row.fat_g),
    fiber: Number(row.fiber_g),
    id: row.id,
    items: row.items.map((item) =>
      detail === "full"
        ? { ...item }
        : {
            amount: item.amount,
            kcal: round(foodItemTotals(item).kcal, 0),
            name: item.name,
            unit: item.unit,
          },
    ),
    kcal: Number(row.kcal),
    note: row.note,
    protein: Number(row.protein_g),
    time: row.time,
    title: row.title,
    version: row.version,
    waterMl: row.water_ml,
  };
}

const SELECT = `SELECT id, local_date::text AS date, to_char(eaten_at AT TIME ZONE $2, 'HH24:MI') AS time,
  title, estimate_source, items, kcal, protein_g, fat_g, carbs_g, fiber_g, water_ml, note, version
  FROM health_food_entries`;

async function selectEntry(
  tx: HealthTransaction,
  id: string,
  lock: boolean,
): Promise<FoodRow | null> {
  const result = await tx.client.query<FoodRow>(
    `${SELECT} WHERE id = $1 AND owner_user_id = $3 AND removed_at IS NULL${lock ? " FOR UPDATE" : ""}`,
    [id, tx.timezone, tx.ownerUserId],
  );
  return result.rows[0] ?? null;
}

/** Totals over every entry of the day, without reading the entries. */
async function dayTotals(tx: HealthTransaction, date: string) {
  const totals = await tx.client.query<{
    approximate: number;
    carbs: string;
    entries: number;
    fat: string;
    fiber: string;
    kcal: string;
    protein: string;
    water: string;
  }>(
    `SELECT count(*)::integer AS entries,
            count(*) FILTER (WHERE estimate_source IN ('described', 'photo'))::integer AS approximate,
            coalesce(sum(kcal), 0)::text AS kcal, coalesce(sum(protein_g), 0)::text AS protein,
            coalesce(sum(fat_g), 0)::text AS fat, coalesce(sum(carbs_g), 0)::text AS carbs,
            coalesce(sum(fiber_g), 0)::text AS fiber, coalesce(sum(water_ml), 0)::text AS water
       FROM health_food_entries
      WHERE owner_user_id = $1 AND local_date = $2::date AND removed_at IS NULL`,
    [tx.ownerUserId, date],
  );
  const sum = totals.rows[0]!;
  return {
    approximateEntries: sum.approximate,
    carbs: round(Number(sum.carbs), 1),
    entries: sum.entries,
    fat: round(Number(sum.fat), 1),
    fiber: round(Number(sum.fiber), 1),
    kcal: round(Number(sum.kcal), 1),
    protein: round(Number(sum.protein), 1),
    waterMl: Number(sum.water),
  };
}

/** The day's list is capped; its totals cover every entry of the day. */
async function day(tx: HealthTransaction, date: string) {
  const result = await tx.client.query<FoodRow>(
    `${SELECT} WHERE owner_user_id = $1 AND local_date = $3::date AND removed_at IS NULL
      ORDER BY eaten_at, created_at LIMIT ${DAY_ENTRY_LIMIT + 1}`,
    [tx.ownerUserId, tx.timezone, date],
  );
  return {
    date,
    entries: result.rows.slice(0, DAY_ENTRY_LIMIT).map((row) => present(row, "compact")),
    hasMore: result.rows.length > DAY_ENTRY_LIMIT,
    totals: await dayTotals(tx, date),
  };
}

export const foodLogRepository = {
  async execute(auth: MemoryAuthorization, raw: FoodLogInput, operationKey: string) {
    const parsed = foodLogInput.safeParse(raw);
    if (!parsed.success)
      inputInvalid(
        "записи о еде",
        "manage_food_log",
        ": у каждой позиции amount, unit и per100 (на 100 г или мл), у add — title и estimateSource",
      );
    const input = parsed.data;
    return await withHealthTransaction(auth, async (tx) => {
      if (input.action === "day") return await day(tx, input.date ?? tx.today);
      if (input.action === "get") {
        const row = await selectEntry(tx, input.id!, false);
        if (!row) throw notFound("Запись о еде", "manage_food_log day");
        return { entry: present(row, "full") };
      }
      return await replayable(tx, operationKey, input, async () => {
        if (input.action === "add") {
          const { date, time } = stampOf(tx, input.date, input.time);
          const totals = foodEntryTotals(input.items!);
          const inserted = await tx.client.query<{ id: string }>(
            `INSERT INTO health_food_entries
               (family_id, owner_user_id, eaten_at, local_date, title, estimate_source, items,
                kcal, protein_g, fat_g, carbs_g, fiber_g, water_ml, note)
             VALUES ($1, $2, ($3::date + $4::time) AT TIME ZONE $5, $3::date, $6, $7, $8,
                     $9, $10, $11, $12, $13, $14, $15)
             RETURNING id`,
            [
              tx.familyId,
              tx.ownerUserId,
              date,
              time,
              tx.timezone,
              input.title,
              input.estimateSource,
              JSON.stringify(input.items),
              totals.kcal,
              totals.protein,
              totals.fat,
              totals.carbs,
              totals.fiber,
              totals.waterMl,
              input.note ?? null,
            ],
          );
          const row = await selectEntry(tx, inserted.rows[0]!.id, false);
          return { entry: present(row!, "compact"), dayTotals: await dayTotals(tx, date) };
        }
        const current = await selectEntry(tx, input.id!, true);
        if (!current) throw notFound("Запись о еде", "manage_food_log day");
        if (current.version !== input.version) throw staleVersion("Запись о еде");
        if (input.action === "remove") {
          await tx.client.query(
            "UPDATE health_food_entries SET removed_at = now(), version = version + 1, updated_at = now() WHERE id = $1",
            [current.id],
          );
          return {
            removed: { id: current.id, title: current.title },
            dayTotals: await dayTotals(tx, current.date),
          };
        }
        const date = input.date ?? current.date;
        requireNotFutureMoment(tx, date, input.time ?? current.time, "date");
        const time = input.time ?? current.time;
        // Only a new date or time moves the meal: re-reading its clock in a timezone changed since
        // would otherwise shift the moment of an untouched meal by the difference.
        const moved = input.date !== undefined || input.time !== undefined;
        const items = input.items ?? current.items;
        const totals = foodEntryTotals(items);
        await tx.client.query(
          `UPDATE health_food_entries
              SET eaten_at = CASE WHEN $15 THEN ($2::date + $3::time) AT TIME ZONE $4 ELSE eaten_at END,
                  local_date = CASE WHEN $15 THEN $2::date ELSE local_date END,
                  title = $5, estimate_source = $6, items = $7, kcal = $8, protein_g = $9,
                  fat_g = $10, carbs_g = $11, fiber_g = $12, water_ml = $13, note = $14,
                  version = version + 1, updated_at = now()
            WHERE id = $1`,
          [
            current.id,
            date,
            time,
            tx.timezone,
            input.title ?? current.title,
            input.estimateSource ?? current.estimate_source,
            JSON.stringify(items),
            totals.kcal,
            totals.protein,
            totals.fat,
            totals.carbs,
            totals.fiber,
            totals.waterMl,
            input.note === undefined ? current.note : input.note,
            moved,
          ],
        );
        const row = await selectEntry(tx, current.id, false);
        return { entry: present(row!, "compact"), dayTotals: await dayTotals(tx, date) };
      });
    });
  },
};
