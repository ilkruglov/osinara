/**
 * The person's food and drink journal, in their private chat.
 *
 * Export:
 * - `manage_food_log`: add a meal or drink, read one, correct it, remove it, list a day with totals.
 */
import { defineTool } from "eve/tools";

import { foodLogInput } from "../health-journal/food-log-input.js";
import { foodLogRepository } from "../health-journal/food-log-repository.js";
import { requireMemoryAuthorization } from "../memory-context.js";

export default defineTool({
  description: [
    "Дневник еды и напитков человека (личный чат): что он съел или выпил по словам, голосу или фото. Не для меню, рецептов и советов без записи.",
    "add: title, estimateSource и items с amount, unit и per100; итоги считает инструмент. day — записи дня с итогами, get — запись целиком, update и remove — по id и version.",
    "Отвечай по dayTotals из результата. Порядок оценки — навык health-journal.",
  ].join(" "),
  inputSchema: foodLogInput,
  async execute(input, ctx) {
    return await foodLogRepository.execute(
      requireMemoryAuthorization(ctx),
      input,
      `${ctx.session.id}:${ctx.callId}`,
    );
  },
});
