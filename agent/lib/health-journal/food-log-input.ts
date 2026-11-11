/**
 * Input of the food and drink journal.
 *
 * Exports:
 * - `foodLogInput`: the validated tool input (flat object root, as DeepSeek requires).
 * - `FoodLogInput`, `FoodItemInput`: their types.
 * - `foodItemTotals`, `foodEntryTotals`: what a composition adds up to.
 *
 * Key construct: the model gives each item's amount and its values per 100 g or ml (from a label, the
 * reference table or its own estimate); the totals are multiplied and summed here, so a corrected
 * amount («там было 200 г риса») is a recalculation, not a new guess.
 */
import { z } from "zod";

import { round } from "./health-formulas.js";
import { civilDate, clockTime, rejectForeignFields } from "./health-access.js";

const per100 = z
  .object({
    carbs: z.number().min(0).max(100),
    fat: z.number().min(0).max(100),
    fiber: z.number().min(0).max(100),
    kcal: z.number().min(0).max(900),
    protein: z.number().min(0).max(100),
  })
  .strict()
  .describe(
    "Пищевая ценность на 100 г или 100 мл: ккал, белки, жиры, углеводы, клетчатка в граммах",
  );

const foodItem = z
  .object({
    amount: z.number().positive().max(5000).describe("Сколько съедено или выпито"),
    countsAsWater: z
      .boolean()
      .optional()
      .describe("Напиток засчитывается в воду дня: вода, чай, кофе, морс, сок; алкоголь — нет"),
    name: z.string().trim().min(1).max(100),
    per100,
    unit: z.enum(["g", "ml"]),
  })
  .strict();

const FIELDS: Readonly<Record<string, readonly string[]>> = {
  add: ["date", "time", "title", "estimateSource", "items", "note"],
  day: ["date"],
  get: ["id"],
  remove: ["id", "version"],
  update: ["id", "version", "date", "time", "title", "estimateSource", "items", "note"],
};

export const foodLogInput = z
  .object({
    action: z.enum(["add", "get", "update", "remove", "day"]),
    date: civilDate().optional().describe("Местная дата YYYY-MM-DD; по умолчанию сегодня"),
    estimateSource: z
      .enum(["label", "weighed", "described", "photo"])
      .optional()
      .describe("label — этикетка, weighed — взвешено, described — со слов, photo — по фото"),
    id: z.uuid().optional(),
    items: z.array(foodItem).min(1).max(30).optional(),
    note: z.string().trim().min(1).max(500).nullable().optional(),
    time: clockTime().optional().describe("Местное время HH:MM"),
    title: z.string().trim().min(1).max(200).optional().describe("Короткое название для дневника"),
    version: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    rejectForeignFields(FIELDS, value, ctx);
    if (value.action === "add" && (!value.title || !value.estimateSource || !value.items))
      ctx.addIssue({ code: "custom", message: "Для add нужны title, estimateSource и items" });
    if (["get", "update", "remove"].includes(value.action) && !value.id)
      ctx.addIssue({ code: "custom", message: "Нужен id записи из day" });
    if (["update", "remove"].includes(value.action) && !value.version)
      ctx.addIssue({ code: "custom", message: "Нужна актуальная version записи" });
    if (
      value.action === "update" &&
      Object.keys(value).every((key) => ["action", "id", "version"].includes(key))
    )
      ctx.addIssue({ code: "custom", message: "Для update нужно хотя бы одно изменённое поле" });
    for (const item of value.items ?? []) {
      // Fiber is not added: USDA carbohydrate «by difference» already includes it, labels here do not.
      const p = item.per100;
      if (p.protein + p.fat + p.carbs > 105)
        ctx.addIssue({
          code: "custom",
          message: `«${item.name}»: белков, жиров и углеводов больше 100 г на 100 г`,
        });
      if (item.countsAsWater === true && item.unit !== "ml")
        ctx.addIssue({ code: "custom", message: `«${item.name}»: в воду засчитываются только мл` });
    }
    // The table's own ranges: one entry is one meal or drink, not a day or a pantry.
    if (value.items !== undefined) {
      const totals = foodEntryTotals(value.items);
      if (
        totals.kcal > 20_000 ||
        totals.waterMl > 20_000 ||
        totals.protein > 2_000 ||
        totals.fat > 2_000 ||
        totals.carbs > 4_000 ||
        totals.fiber > 1_000
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Запись больше 20 000 ккал или 20 л: это один приём пищи или напиток — проверь граммы",
        });
    }
  });

export type FoodLogInput = z.infer<typeof foodLogInput>;
export type FoodItemInput = z.infer<typeof foodItem>;

export interface FoodTotals {
  carbs: number;
  fat: number;
  fiber: number;
  kcal: number;
  protein: number;
  waterMl: number;
}

export function foodItemTotals(item: FoodItemInput): FoodTotals {
  const factor = item.amount / 100;
  return {
    carbs: item.per100.carbs * factor,
    fat: item.per100.fat * factor,
    fiber: item.per100.fiber * factor,
    kcal: item.per100.kcal * factor,
    protein: item.per100.protein * factor,
    waterMl: item.countsAsWater === true && item.unit === "ml" ? item.amount : 0,
  };
}

export function foodEntryTotals(items: readonly FoodItemInput[]): FoodTotals {
  const sum = items.map(foodItemTotals).reduce(
    (total, item) => ({
      carbs: total.carbs + item.carbs,
      fat: total.fat + item.fat,
      fiber: total.fiber + item.fiber,
      kcal: total.kcal + item.kcal,
      protein: total.protein + item.protein,
      waterMl: total.waterMl + item.waterMl,
    }),
    { carbs: 0, fat: 0, fiber: 0, kcal: 0, protein: 0, waterMl: 0 },
  );
  return {
    carbs: round(sum.carbs, 1),
    fat: round(sum.fat, 1),
    fiber: round(sum.fiber, 1),
    kcal: round(sum.kcal, 1),
    protein: round(sum.protein, 1),
    waterMl: Math.round(sum.waterMl),
  };
}
