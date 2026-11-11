/**
 * The day and week summaries of the health journal, with their widget cards.
 *
 * Exports:
 * - `healthSummaryInput`, `HealthSummaryInput`: the validated tool input.
 * - `buildHealthSummary`: computes a summary and, on request, writes its card file.
 *
 * Key constructs:
 * - The card is written by code from the computed numbers; the model only sends it with
 *   `send_widget`, so the card cannot show a number the database does not hold.
 * - Cards are immutable files named by their content (`health-card-files.ts`); a newer card drops
 *   the older ones of its kind, and an erase during the write removes the card.
 * - With widgets switched off the numbers still come back, for a text answer.
 */
import { z } from "zod";

import type { MemoryAuthorization } from "../memory-context.js";
import { TELEGRAM_WIDGETS_ENABLED } from "../telegram-widgets/telegram-widget-availability.js";
import { requireTelegramWidgetSize } from "../telegram-widgets/telegram-widget-limits.js";
import { database } from "../database.js";
import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";
import {
  civilDate,
  inputInvalid,
  requireNotFuture,
  withHealthTransaction,
} from "./health-access.js";
import { eraseCount, publishHealthCard, workspaceHealthCardStore } from "./health-card-files.js";
import { checkSentence, num, renderDayCard, renderWeekCard, signed } from "./health-cards.js";
import {
  type DaySummary,
  loadDaySummary,
  loadWeekSummary,
  type WeekSummary,
} from "./health-summary-data.js";

export const healthSummaryInput = z
  .object({
    action: z.enum(["day", "week"]),
    card: z.boolean().optional().describe("Собрать карточку для send_widget"),
    date: civilDate()
      .optional()
      .describe("day: день; week: последний день недели. По умолчанию сегодня"),
    view: z
      .enum(["progress", "evening"])
      .optional()
      .describe(
        "Только для day: progress — сколько осталось до цели, evening — баланс съеденного и расхода",
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === "week" && value.view !== undefined)
      ctx.addIssue({ code: "custom", message: "view задаётся только для day" });
  });

export type HealthSummaryInput = z.infer<typeof healthSummaryInput>;

function dayCaption(day: DaySummary, view: "evening" | "progress"): string {
  const eaten = `${num(day.eaten.kcal)} ккал, белок ${num(day.eaten.protein)} г`;
  if (view === "evening" && day.balanceKcal !== null)
    return `Итог дня: ${eaten}, баланс ${signed(day.balanceKcal)} ккал`;
  if (day.remainingKcal !== null)
    return day.remainingKcal >= 0
      ? `${eaten}; до цели ${num(day.remainingKcal)} ккал`
      : `${eaten}; сверх цели ${num(-day.remainingKcal)} ккал`;
  return `Съедено ${eaten}`;
}

function weekCaption(week: WeekSummary): string {
  const kcal =
    week.averages.kcal === null ? "нет записей еды" : `${num(week.averages.kcal)} ккал в день`;
  const weight = week.weight.changeKg === null ? "" : `, вес ${signed(week.weight.changeKg, 1)} кг`;
  return `Неделя: ${kcal}${weight}`;
}

export async function buildHealthSummary(
  auth: MemoryAuthorization,
  workspace: () => WorkspaceAuthorization,
  raw: HealthSummaryInput,
  operationKey: string,
) {
  const parsed = healthSummaryInput.safeParse(raw);
  if (!parsed.success) inputInvalid("сводки", "health_summary");
  const input = parsed.data;
  const view = input.view ?? "progress";
  const computed = await withHealthTransaction(auth, async (tx) => {
    const date = input.date ?? tx.today;
    requireNotFuture(tx, date, "date");
    const erasesBefore = await eraseCount(tx.client, tx.ownerUserId);
    return input.action === "day"
      ? {
          day: await loadDaySummary(tx, date),
          erasesBefore,
          kind: "day" as const,
          owner: tx.ownerUserId,
        }
      : {
          erasesBefore,
          kind: "week" as const,
          owner: tx.ownerUserId,
          week: await loadWeekSummary(tx, date),
        };
  });
  const result: Record<string, unknown> =
    computed.kind === "day"
      ? { day: computed.day }
      : {
          week: computed.week,
          weeklyCheck: { ...computed.week.check, sentence: checkSentence(computed.week) },
        };
  if (input.card !== true) return result;
  if (!TELEGRAM_WIDGETS_ENABLED)
    return {
      ...result,
      card: null,
      cardUnavailable: "Карточки выключены: ответь текстом по этим числам.",
    };
  const html =
    computed.kind === "day" ? renderDayCard(computed.day, view) : renderWeekCard(computed.week);
  const size = requireTelegramWidgetSize(html);
  const path = await publishHealthCard(workspaceHealthCardStore(workspace), {
    erasesBefore: computed.erasesBefore,
    // Read after the write on its own connection: no transaction is held at this point.
    erasesNow: async () => await eraseCount(database(), computed.owner),
    html,
    kind: computed.kind === "week" ? "week" : view === "evening" ? "day-evening" : "day-progress",
    operationKey,
  });
  return {
    ...result,
    card: {
      caption:
        computed.kind === "day" ? dayCaption(computed.day, view) : weekCaption(computed.week),
      path,
      scope: "personal",
      size,
    },
  };
}
