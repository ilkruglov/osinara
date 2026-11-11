/**
 * The person's workouts, in their private chat.
 *
 * Export:
 * - `manage_workouts`: add, read, correct, remove and list workouts; an exercise's progress.
 */
import { defineTool } from "eve/tools";

import { workoutRepository } from "../health-journal/workout-repository.js";
import { workoutInput } from "../health-journal/workout-input.js";
import { requireMemoryAuthorization } from "../memory-context.js";

export default defineTool({
  description: [
    "Тренировки человека (личный чат): зал по упражнениям и подходам, кардио, игры, растяжка. Шаги и обычная ходьба — manage_sleep_activity.",
    "add — kind, title, durationMin, intensity, для зала exercises с подходами; тоннаж считает инструмент. list, get, update и remove — по id и version; progress — история упражнения и рекорды.",
  ].join(" "),
  inputSchema: workoutInput,
  async execute(input, ctx) {
    return await workoutRepository.execute(
      requireMemoryAuthorization(ctx),
      input,
      `${ctx.session.id}:${ctx.callId}`,
    );
  },
});
