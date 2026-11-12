/**
 * The person's body parameters, goals, targets and measurements, in their private chat.
 *
 * Export:
 * - `manage_body_profile`: read the profile with targets, change it, log/list/remove weight and
 *   measurements, accept the weekly correction, erase the whole health journal (approved in Telegram).
 */
import { defineTool } from "eve/tools";

import { bodyProfileInput } from "../health-journal/body-profile-input.js";
import { bodyProfileRepository } from "../health-journal/body-profile-repository.js";
import {
  removeHealthCards,
  workspaceHealthCardStore,
} from "../health-journal/health-card-files.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";

// Erasing the journal cannot be undone, and moving it decides which records count, so the person
// confirms both with a button; the rest is their own journal written at their word, like the
// shopping list.
const APPROVAL_ACTIONS = new Set(["erase_all", "set_journal_mode"]);

export default defineTool({
  approval: ({ toolInput }) => {
    const action = (toolInput as { action?: unknown } | undefined)?.action;
    return typeof action === "string" && APPROVAL_ACTIONS.has(action)
      ? "user-approval"
      : "not-applicable";
  },
  description: [
    "Тело, цели и нормы человека (личный чат): вес и замеры, параметры для нормы, цель похудеть/держать/набрать, своя норма, недельная поправка, стирание всего дневника. Не для еды, сна и тренировок.",
    "get — профиль, нормы (targets, missing), тренд веса и journal: где дневник (mode), с какого времени и были ли стирания; set_profile — изменённые поля с version из get; log_/list_/remove_measurement — замеры.",
    "apply_adjustment — только после «да» человека, с числом из health_summary week; erase_all и set_journal_mode — только по прямой просьбе, подтверждаются кнопкой. Опасную цель инструмент отклонит сам.",
  ].join(" "),
  inputSchema: bodyProfileInput,
  async execute(input, ctx) {
    const operationKey = `${ctx.session.id}:${ctx.callId}`;
    const result = await bodyProfileRepository.execute(
      requireMemoryAuthorization(ctx),
      input,
      operationKey,
    );
    if (input.action !== "erase_all") return result;
    // The cards hold journal numbers too; they are the only files the journal writes.
    const cards = await removeHealthCards(
      workspaceHealthCardStore(() => requireWorkspaceAuthorization(ctx)),
      operationKey,
    );
    return { ...result, cardsRemoved: cards };
  },
});
