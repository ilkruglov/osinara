/**
 * Input of the sleep and daily activity tool.
 *
 * Exports:
 * - `sleepActivityInput`, `SleepActivityInput`: the validated tool input (flat object root).
 * - `sleepStartDate`: the civil date a night starts on, from bedtime and wake time.
 */
import { z } from "zod";

import { civilDate, clockTime, rejectForeignFields } from "./health-access.js";
import { addDays } from "./health-formulas.js";

const minutes = (what: string) => z.number().int().min(0).max(1440).optional().describe(what);

const FIELDS: Readonly<Record<string, readonly string[]>> = {
  import_zepp: ["path", "password", "since"],
  list: ["from", "to"],
  log_activity: ["date", "steps", "distanceM", "restingHr", "source", "note"],
  log_sleep: [
    "wakeDate",
    "bedtime",
    "wakeTime",
    "totalMin",
    "deepMin",
    "lightMin",
    "remMin",
    "awakeMin",
    "source",
    "note",
    "version",
  ],
  remove: ["kind", "date"],
};

export const sleepActivityInput = z
  .object({
    action: z.enum(["log_sleep", "log_activity", "list", "remove", "import_zepp"]),
    awakeMin: minutes("Минуты бодрствования внутри ночи"),
    bedtime: clockTime().optional().describe("Местное время засыпания HH:MM"),
    date: civilDate().optional().describe("Местная дата YYYY-MM-DD; по умолчанию сегодня"),
    deepMin: minutes("Глубокий сон, мин"),
    distanceM: z.number().int().min(0).max(300_000).optional(),
    from: civilDate().optional(),
    kind: z.enum(["sleep", "activity"]).optional(),
    lightMin: minutes("Лёгкий (поверхностный) сон, мин"),
    note: z.string().trim().min(1).max(500).optional(),
    password: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("Пароль архива выгрузки, который показало приложение Zepp"),
    path: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe("Путь к .zip выгрузки в личном workspace, например inbox/4096/export.zip"),
    remMin: minutes("Фаза быстрого сна, мин"),
    restingHr: z.number().int().min(25).max(200).optional().describe("Пульс покоя утром"),
    since: civilDate().optional().describe("Импортировать только дни с этой даты"),
    source: z
      .enum(["text", "screenshot"])
      .optional()
      .describe("text — со слов, screenshot — с экрана приложения"),
    steps: z.number().int().min(0).max(150_000).optional(),
    to: civilDate().optional(),
    totalMin: z.number().int().min(1).max(1440).optional().describe("Сколько спал всего, мин"),
    version: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Нужна, чтобы заменить уже записанную ночь"),
    wakeDate: civilDate()
      .optional()
      .describe("Дата пробуждения: ночь относится к дню, в который человек проснулся"),
    wakeTime: clockTime().optional().describe("Местное время подъёма HH:MM"),
  })
  .strict()
  .superRefine((value, ctx) => {
    rejectForeignFields(FIELDS, value, ctx);
    if ((value.action === "log_sleep" || value.action === "log_activity") && !value.source)
      ctx.addIssue({ code: "custom", message: "Нужен source" });
    if (value.action === "log_sleep") {
      const phases = [value.deepMin, value.lightMin, value.remMin].some(
        (item) => item !== undefined,
      );
      const window = value.bedtime !== undefined && value.wakeTime !== undefined;
      if (value.totalMin === undefined && !phases && !window)
        ctx.addIssue({
          code: "custom",
          message: "Нужны totalMin, фазы сна или bedtime и wakeTime",
        });
      if ((value.bedtime === undefined) !== (value.wakeTime === undefined))
        ctx.addIssue({ code: "custom", message: "bedtime и wakeTime задаются вместе" });
    }
    if (
      value.action === "log_activity" &&
      value.steps === undefined &&
      value.distanceM === undefined &&
      value.restingHr === undefined
    )
      ctx.addIssue({ code: "custom", message: "Нужны шаги, дистанция или пульс покоя" });
    if (value.action === "remove" && (!value.kind || !value.date))
      ctx.addIssue({ code: "custom", message: "Для remove нужны kind и date" });
    if (value.action === "import_zepp" && !value.path)
      ctx.addIssue({ code: "custom", message: "Нужен path к архиву выгрузки" });
  });

export type SleepActivityInput = z.infer<typeof sleepActivityInput>;

/** Bedtime after the wake time means the night started the day before waking. */
export function sleepStartDate(wakeDate: string, bedtime: string, wakeTime: string): string {
  return bedtime > wakeTime ? addDays(wakeDate, -1) : wakeDate;
}
