/**
 * Settled prompt tests.
 *
 * Constructs covered:
 * - `settledPromptText`: removes the forward-looking consequence of every composed window.
 * - A prompt from an older release keeps its full text instead of losing its last block.
 */
import { describe, expect, it } from "vitest";

import { buildApprovalMessage, DEFAULT_CONSEQUENCE } from "./approval-message.js";
import { GOOGLE_WORKSPACE_CONSEQUENCE } from "./approval-presentation.js";
import { settledPromptText } from "./settled-prompt.js";

describe("settledPromptText", () => {
  it("removes the default consequence once the request is settled", () => {
    const prompt = buildApprovalMessage({
      actionLabel: "изменить напоминание",
      facts: ["ID: 1"],
    });
    expect(prompt).toContain(DEFAULT_CONSEQUENCE);

    const settled = settledPromptText(prompt);
    expect(settled).not.toContain("будет выполнено один раз");
    expect(settled).toBe("Подтверждение: изменить напоминание.\n\nID: 1");
  });

  it("removes a per-tool consequence too", () => {
    const prompt = buildApprovalMessage({
      actionLabel: "изменение в Google Workspace",
      consequence: GOOGLE_WORKSPACE_CONSEQUENCE,
      facts: ["Сервис: Gmail"],
    });
    expect(settledPromptText(prompt)).toBe(
      "Подтверждение: изменение в Google Workspace.\n\nСервис: Gmail",
    );
  });

  it("removes a schedule consequence", () => {
    const prompt = buildApprovalMessage({
      actionLabel: "приостановить агентное расписание",
      consequence: "Будущие автоматические запуски остановятся до ручного возобновления.",
      facts: ["Расписание: Утренние новости"],
    });
    expect(settledPromptText(prompt)).not.toContain("остановятся до ручного возобновления");
  });

  it("leaves a prompt composed by an older release intact", () => {
    // Такие строки могут висеть pending через деплой; отрезать у них последний блок нельзя.
    const legacy = "Подтвердите действие: удалить файл.\n\nПуть: notes/plan.md";
    expect(settledPromptText(legacy)).toBe(legacy);
  });
});
