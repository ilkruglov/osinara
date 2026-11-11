/**
 * The day and week summaries of the person's health journal, with widget cards.
 *
 * Export:
 * - `health_summary`: computed numbers of a day or a week; with `card` also the card file to send.
 */
import { defineTool } from "eve/tools";

import { buildHealthSummary, healthSummaryInput } from "../health-journal/health-summary.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";

export default defineTool({
  description: [
    "Сводка дневника здоровья за день или неделю: что спросили «сколько съел, сколько осталось, как неделя», просят дашборд, вечерняя и недельная сводка по расписанию. Не для записи.",
    "day: view progress — до цели, evening — баланс с расходом. week: с weeklyCheck — сверкой расхода по весу.",
    "card=true — отправь card.path, card.scope и card.caption через send_widget и не пересказывай карточку; card=null — ответь текстом. Числа уже посчитаны, не пересчитывай.",
  ].join(" "),
  inputSchema: healthSummaryInput,
  async execute(input, ctx) {
    return await buildHealthSummary(
      requireMemoryAuthorization(ctx),
      () => requireWorkspaceAuthorization(ctx),
      input,
      `${ctx.session.id}:${ctx.callId}`,
    );
  },
});
