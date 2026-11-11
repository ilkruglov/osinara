/**
 * Input of the workouts tool.
 *
 * Exports:
 * - `workoutInput`, `WorkoutInput`, `ExerciseInput`: the validated tool input (flat object root).
 */
import { z } from "zod";

import { civilDate, clockTime, rejectForeignFields } from "./health-access.js";

const workoutSet = z
  .object({
    durationS: z
      .number()
      .int()
      .min(1)
      .max(36_000)
      .optional()
      .describe("Для упражнений на время, с"),
    reps: z.number().int().min(1).max(1000).optional(),
    weightKg: z.number().min(0).max(1000).optional().describe("Рабочий вес; без веса — своё тело"),
  })
  .strict();

const exercise = z
  .object({
    name: z.string().trim().min(1).max(100),
    sets: z
      .array(workoutSet)
      .min(1)
      .max(30)
      .describe("Каждый подход отдельно, в порядке выполнения"),
  })
  .strict();

const FIELDS: Readonly<Record<string, readonly string[]>> = {
  add: ["date", "time", "kind", "title", "durationMin", "intensity", "exercises", "note"],
  get: ["id"],
  list: ["from", "to"],
  progress: ["exercise"],
  remove: ["id", "version"],
  update: [
    "id",
    "version",
    "date",
    "time",
    "kind",
    "title",
    "durationMin",
    "intensity",
    "exercises",
    "note",
  ],
};

export const workoutInput = z
  .object({
    action: z.enum(["add", "get", "update", "remove", "list", "progress"]),
    date: civilDate().optional().describe("Местная дата; по умолчанию сегодня"),
    durationMin: z.number().int().min(1).max(720).optional(),
    exercise: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe("Название упражнения для progress"),
    exercises: z.array(exercise).max(30).optional(),
    from: civilDate().optional(),
    id: z.uuid().optional(),
    intensity: z
      .enum(["light", "moderate", "vigorous"])
      .optional()
      .describe("light — можно петь, moderate — можно говорить, vigorous — трудно говорить"),
    kind: z
      .enum(["strength", "cardio", "sport", "mobility"])
      .optional()
      .describe(
        "strength — зал, cardio — бег, вело, плавание, sport — игровые виды спорта, mobility — йога, растяжка",
      ),
    note: z.string().trim().min(1).max(500).nullable().optional(),
    time: clockTime().optional().describe("Местное время начала HH:MM"),
    title: z.string().trim().min(1).max(120).optional(),
    to: civilDate().optional(),
    version: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    rejectForeignFields(FIELDS, value, ctx);
    if (
      value.action === "add" &&
      (!value.kind || !value.title || !value.durationMin || !value.intensity)
    )
      ctx.addIssue({
        code: "custom",
        message: "Для add нужны kind, title, durationMin и intensity",
      });
    if (["get", "update", "remove"].includes(value.action) && !value.id)
      ctx.addIssue({ code: "custom", message: "Нужен id тренировки из list" });
    if (["update", "remove"].includes(value.action) && !value.version)
      ctx.addIssue({ code: "custom", message: "Нужна актуальная version тренировки" });
    if (value.action === "progress" && !value.exercise)
      ctx.addIssue({ code: "custom", message: "Для progress нужно название упражнения" });
    const sets = (value.exercises ?? []).reduce((sum, item) => sum + item.sets.length, 0);
    if (sets > 300)
      ctx.addIssue({ code: "custom", message: "Больше 300 подходов в одной тренировке" });
    for (const item of value.exercises ?? [])
      for (const set of item.sets)
        if (set.reps === undefined && set.durationS === undefined)
          ctx.addIssue({
            code: "custom",
            message: `«${item.name}»: у подхода нужны повторы или время`,
          });
  });

export type WorkoutInput = z.infer<typeof workoutInput>;
export type ExerciseInput = z.infer<typeof exercise>;
