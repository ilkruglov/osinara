/**
 * Input of the body, goals and targets tool.
 *
 * Exports:
 * - `bodyProfileInput`, `BodyProfileInput`: the validated tool input (flat object root).
 * - `PROFILE_FIELDS`: the profile fields `set_profile` may change, with their column names.
 */
import { z } from "zod";

import { civilDate, clockTime, JOURNAL_MODES, rejectForeignFields } from "./health-access.js";

export const PROFILE_FIELDS = {
  activityLevel: "activity_level",
  birthDate: "birth_date",
  carbsTargetG: "manual_carbs_g",
  deficitBlock: "deficit_block",
  fatTargetG: "manual_fat_g",
  fiberTargetG: "manual_fiber_g",
  goal: "goal",
  heightCm: "height_cm",
  kcalTarget: "manual_kcal",
  proteinTargetG: "manual_protein_g",
  sex: "sex",
  waterTargetMl: "manual_water_ml",
  weeklyRateKg: "weekly_rate_kg",
} as const;

const FIELDS: Readonly<Record<string, readonly string[]>> = {
  apply_adjustment: ["adjustmentKcal", "version"],
  erase_all: [],
  get: [],
  list_measurements: ["from", "to"],
  log_measurement: [
    "date",
    "time",
    "weightKg",
    "bodyFatPct",
    "musclePct",
    "waistCm",
    "source",
    "note",
  ],
  remove_measurement: ["id"],
  set_journal_mode: ["journalMode"],
  set_profile: [...Object.keys(PROFILE_FIELDS), "version"],
};

const target = (max: number, what: string) =>
  z
    .number()
    .int()
    .min(0)
    .max(max)
    .nullable()
    .optional()
    .describe(`${what}; null — снова по формуле`);

export const bodyProfileInput = z
  .object({
    action: z.enum([
      "get",
      "set_profile",
      "log_measurement",
      "list_measurements",
      "remove_measurement",
      "apply_adjustment",
      "erase_all",
      "set_journal_mode",
    ]),
    activityLevel: z
      .enum(["sedentary", "light", "moderate", "active", "very_active"])
      .nullable()
      .optional()
      .describe(
        "Обычный день без учёта тренировок: сидячий, лёгкий, умеренный, активный, очень активный",
      ),
    adjustmentKcal: z
      .number()
      .int()
      .min(-800)
      .max(800)
      .optional()
      .describe("Ровно proposedAdjustmentKcal из недельной сверки health_summary week"),
    birthDate: civilDate().nullable().optional(),
    bodyFatPct: z.number().min(2).max(75).optional(),
    carbsTargetG: target(1000, "Своя цель углеводов, г"),
    date: civilDate().optional().describe("Местная дата замера; по умолчанию сегодня"),
    deficitBlock: z
      .enum(["pregnancy", "lactation", "eating_disorder", "medical"])
      .nullable()
      .optional()
      .describe("Причина, по которой дефицит калорий запрещён; null снимает запрет"),
    fatTargetG: target(400, "Своя цель жиров, г"),
    fiberTargetG: target(150, "Своя цель клетчатки, г"),
    from: civilDate().optional(),
    goal: z.enum(["lose", "maintain", "gain"]).nullable().optional(),
    heightCm: z.number().min(100).max(250).nullable().optional(),
    id: z.uuid().optional(),
    journalMode: z
      .enum(JOURNAL_MODES)
      .optional()
      .describe(
        "Только по прямому слову человека: database — этот дневник, files — его файлы health/",
      ),
    kcalTarget: target(6000, "Своя цель калорий в день"),
    musclePct: z.number().min(10).max(90).optional(),
    note: z.string().trim().min(1).max(500).optional(),
    proteinTargetG: target(400, "Своя цель белка, г"),
    sex: z.enum(["female", "male"]).nullable().optional(),
    source: z
      .enum(["text", "screenshot"])
      .optional()
      .describe("text — со слов, screenshot — с экрана весов"),
    time: clockTime().optional(),
    to: civilDate().optional(),
    version: z.number().int().positive().optional(),
    waistCm: z.number().min(30).max(250).optional(),
    waterTargetMl: target(8000, "Своя цель воды из напитков, мл"),
    weeklyRateKg: z
      .number()
      .min(0.05)
      .max(1)
      .nullable()
      .optional()
      .describe("Желаемый темп изменения веса в неделю, кг; код сам ограничит безопасным"),
    weightKg: z.number().min(20).max(400).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    rejectForeignFields(FIELDS, value, ctx);
    if (
      value.action === "log_measurement" &&
      value.weightKg === undefined &&
      value.bodyFatPct === undefined &&
      value.waistCm === undefined
    )
      ctx.addIssue({ code: "custom", message: "Нужен вес, процент жира или талия" });
    if (value.action === "log_measurement" && !value.source)
      ctx.addIssue({ code: "custom", message: "Для log_measurement нужен source" });
    if (value.action === "set_journal_mode" && !value.journalMode)
      ctx.addIssue({ code: "custom", message: "Для set_journal_mode нужен journalMode" });
    if (value.action === "remove_measurement" && !value.id)
      ctx.addIssue({ code: "custom", message: "Нужен id замера из list_measurements" });
    if (
      value.action === "apply_adjustment" &&
      (value.adjustmentKcal === undefined || !value.version)
    )
      ctx.addIssue({ code: "custom", message: "Нужны adjustmentKcal и version профиля" });
    if (value.action === "set_profile" && !Object.keys(value).some((key) => key in PROFILE_FIELDS))
      ctx.addIssue({ code: "custom", message: "Для set_profile нужно хотя бы одно поле профиля" });
  });

export type BodyProfileInput = z.infer<typeof bodyProfileInput>;
