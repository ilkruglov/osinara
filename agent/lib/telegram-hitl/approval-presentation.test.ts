/**
 * Semantic Telegram approval presentation tests.
 *
 * Constructs covered:
 * - Existing schedule mutations resolve their user-facing subject from trusted PostgreSQL data.
 * - Schedule updates expose the proposed values as well as the current subject.
 * - Technical UUIDs stay out of confirmation messages.
 * - The prompt explains the exact consequence before a decision is requested.
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
      options: [
        { id: "approve", label: "Yes", style: "primary" },
        { id: "deny", label: "No", style: "default" },
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
      "Нет, отклонить",
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
      options: [
        { id: "approve", label: "Yes", style: "primary" },
        { id: "deny", label: "No", style: "default" },
      ],
      prompt: "Approve tool call",
      requestId: "request-2",
    }, context());

    expect(result.prompt).toContain("Изменения:");
    expect(result.prompt).toContain("Название: Расширенный ИИ-дайджест");
    expect(result.prompt).toContain("Периодичность: каждые 2 дней");
  });
});
