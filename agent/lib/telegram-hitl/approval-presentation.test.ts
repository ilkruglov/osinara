/**
 * Semantic Telegram approval presentation tests.
 *
 * Constructs covered:
 * - Existing schedule mutations resolve their user-facing subject from trusted PostgreSQL data.
 * - Schedule updates expose the proposed values as well as the current subject.
 * - Technical UUIDs stay out of confirmation messages.
 * - The prompt explains the exact consequence before a decision is requested.
 * - Google Workspace mutation approvals expose the complete exact argv.
 * - Long schedule values remain complete for multipart Telegram delivery.
 */
import { describe, expect, it, vi } from "vitest";

import { createTelegramApprovalPresenter } from "./approval-presentation.js";

const SCHEDULE_ID = "5042f71c-4a61-429e-8519-b1e7d0f18fe9";

function context() {
  return {
    session: {
      auth: {
        current: {
          attributes: {
            familyId: "family-1",
            role: "owner",
            telegramChatId: "101",
            telegramChatType: "private",
            telegramUserId: "101",
          },
          authenticator: "telegram",
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
    },
  } as never;
}

const schedule = {
  createdAt: "2026-07-20T10:00:00.000Z",
  id: SCHEDULE_ID,
  lastErrorCode: null,
  messageThreadId: null,
  nextRunAt: "2026-07-31T06:00:00.000Z",
  recurrence: { interval: 1, kind: "daily" as const },
  scenarioPrompt: "Собери главные новости об ИИ и дай ссылки на источники.",
  scope: "personal" as const,
  status: "paused" as const,
  timezone: "Europe/Moscow",
  title: "Утренний дайджест ИИ",
  updatedAt: "2026-07-30T10:00:00.000Z",
  userRequest: "Каждое утро присылай новости об искусственном интеллекте",
};

describe("Telegram approval presentation", () => {
  it("shows every material Google Workspace argument", async () => {
    const present = createTelegramApprovalPresenter({ findSchedule: vi.fn() });
    const argv = [
      "gmail",
      "+send",
      "--to",
      "family@example.com",
      "--subject",
      "Семейный план",
      "--body",
      "Встречаемся в 19:00",
    ];

    const result = await present({
      action: {
        callId: "call-gws",
        input: { argv },
        kind: "tool-call",
        toolName: "execute_google_workspace",
      },
      display: "confirmation",
      kind: "tool-approval",
      options: [
        { id: "approve", label: "Yes", style: "primary" },
        { id: "cancel", label: "No", style: "default" },
      ],
      prompt: "Approve tool call",
      requestId: "request-gws",
    }, context());

    // Каждый материальный аргумент по-прежнему виден, но читаемыми строками, а не дампом массива.
    expect(result.prompt).toContain("Сервис: Gmail");
    expect(result.prompt).toContain("to: family@example.com");
    expect(result.prompt).toContain("subject: Семейный план");
    expect(result.prompt).toContain("body: Встречаемся в 19:00");
    expect(result.prompt).toContain(`Точная команда: ${argv.join(" ")}`);
    expect(result.prompt).not.toContain(JSON.stringify(argv, null, 2));
    expect(result.prompt).toContain("будет выполнена один раз");
  });

  it("describes a schedule resume without exposing its UUID", async () => {
    const findSchedule = vi.fn().mockResolvedValue(schedule);
    const present = createTelegramApprovalPresenter({ findSchedule });

    const result = await present({
      action: {
        callId: "call-1",
        input: { action: "resume", id: SCHEDULE_ID },
        kind: "tool-call",
        toolName: "manage_agent_schedule",
      },
      display: "confirmation",
      kind: "tool-approval",
      options: [
        { id: "approve", label: "Yes", style: "primary" },
        { id: "cancel", label: "No", style: "default" },
      ],
      prompt: "Approve tool call",
      requestId: "request-1",
    }, context());

    expect(result.prompt).toContain("Утренний дайджест ИИ");
    expect(result.prompt).toContain("Каждое утро присылай новости");
    expect(result.prompt).toContain("ежедневно");
    expect(result.prompt).toContain("Автоматические запуски возобновятся");
    expect(result.prompt).not.toContain(SCHEDULE_ID);
    expect(result.options?.map((option) => option.label)).toEqual([
      "Да, подтвердить",
      "Нет, отменить",
    ]);
  });

  it("shows the proposed values for a schedule update", async () => {
    const findSchedule = vi.fn().mockResolvedValue(schedule);
    const present = createTelegramApprovalPresenter({ findSchedule });

    const result = await present({
      action: {
        callId: "call-2",
        input: {
          action: "update",
          id: SCHEDULE_ID,
          recurrence: { interval: 2, kind: "daily" },
          title: "Расширенный ИИ-дайджест",
        },
        kind: "tool-call",
        toolName: "manage_agent_schedule",
      },
      display: "confirmation",
      kind: "tool-approval",
      options: [
        { id: "approve", label: "Yes", style: "primary" },
        { id: "cancel", label: "No", style: "default" },
      ],
      prompt: "Approve tool call",
      requestId: "request-2",
    }, context());

    expect(result.prompt).toContain("Изменения:");
    expect(result.prompt).toContain("Название: Расширенный ИИ-дайджест");
    expect(result.prompt).toContain("Периодичность: каждые 2 дней");
  });

  it("preserves a complete long schedule scenario instead of approving a preview", async () => {
    const findSchedule = vi.fn().mockResolvedValue(schedule);
    const present = createTelegramApprovalPresenter({ findSchedule });
    const scenarioPrompt = `${"Подробный шаг. ".repeat(500)}КОНЕЦ_СЦЕНАРИЯ`;

    const result = await present({
      action: {
        callId: "call-long",
        input: { action: "update", id: SCHEDULE_ID, scenarioPrompt },
        kind: "tool-call",
        toolName: "manage_agent_schedule",
      },
      display: "confirmation",
      kind: "tool-approval",
      options: [
        { id: "approve", label: "Yes", style: "primary" },
        { id: "cancel", label: "No", style: "default" },
      ],
      prompt: "Approve tool call",
      requestId: "request-long",
    }, context());

    expect(result.prompt).toContain(scenarioPrompt);
    expect(result.prompt).toContain("КОНЕЦ_СЦЕНАРИЯ");
    expect(result.prompt).not.toContain("КОНЕЦ_СЦЕНАРИ…");
  });
});
