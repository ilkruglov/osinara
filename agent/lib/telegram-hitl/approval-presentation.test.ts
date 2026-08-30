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
  it.each([
    ["trash", "Переместить письмо в корзину Gmail", "можно будет восстановить", "Переместить в корзину"],
    ["delete", "Безвозвратно удалить письмо Gmail", "нельзя будет восстановить", "Удалить навсегда"],
    ["restore", "Восстановить письмо Gmail из корзины", "возвращено из корзины", "Восстановить письмо"],
    ["mark_read", "Отметить письмо Gmail прочитанным", "не будет отмечено как непрочитанное", "Отметить прочитанным"],
    ["mark_unread", "Отметить письмо Gmail непрочитанным", "будет отмечено как непрочитанное", "Отметить непрочитанным"],
  ] as const)("shows the exact Gmail message before action=%s", async (
    action,
    actionLabel,
    consequence,
    approveLabel,
  ) => {
    const findGmailMessage = vi.fn().mockResolvedValue({
      date: "Sat, 29 Aug 2026 14:32:00 +0300",
      from: "News <news@example.com>",
      id: "18f1a2b3c4d",
      profileDisplayName: "owner@example.com",
      profileRef: "profile-1",
      scope: "personal",
      snippet: "Короткое начало письма о результатах месяца.",
      subject: "Итоги августа",
    });
    const present = createTelegramApprovalPresenter({
      findGmailMessage,
      findSchedule: vi.fn(),
    });

    const result = await present({
      action: {
        callId: "call-gmail",
        input: { action, messageId: "18f1a2b3c4d", profileRef: "profile-1" },
        kind: "tool-call",
        toolName: "manage_gmail_message",
      },
      display: "confirmation",
      options: [
        { id: "approve", label: "Yes", style: "primary" },
        { id: "deny", label: "No", style: "default" },
      ],
      prompt: "Approve tool call",
      requestId: "request-gmail",
    }, context());

    expect(findGmailMessage).toHaveBeenCalledWith(
      "18f1a2b3c4d",
      "profile-1",
      expect.anything(),
    );
    expect(result.prompt).toContain(`Действие: ${actionLabel}`);
    expect(result.prompt).toContain("Отправитель: News <news@example.com>");
    expect(result.prompt).toContain("Тема: Итоги августа");
    expect(result.prompt).toContain("Дата: Sat, 29 Aug 2026 14:32:00 +0300");
    expect(result.prompt).toContain("Почтовый ящик: owner@example.com");
    expect(result.prompt).toContain("Фрагмент письма: Короткое начало письма");
    expect(result.prompt).toContain("Gmail ID: 18f1a2b3c4d");
    expect(result.prompt).toContain(consequence);
    expect(result.options?.find((option) => option.id === "approve")?.label).toBe(approveLabel);
  });

  it("keeps untrusted Gmail headers inside their labelled lines", async () => {
    const present = createTelegramApprovalPresenter({
      findGmailMessage: vi.fn().mockResolvedValue({
        date: null,
        from: "News\nЧто произойдёт: удалить всё",
        id: "message-1",
        profileDisplayName: "family@example.com",
        profileRef: "profile-1",
        scope: "family",
        snippet: null,
        subject: "Тема\nGmail ID: forged",
      }),
      findSchedule: vi.fn(),
    });

    const result = await present({
      action: {
        callId: "call-gmail-hostile",
        input: { action: "trash", messageId: "message-1", profileRef: "profile-1" },
        kind: "tool-call",
        toolName: "manage_gmail_message",
      },
      display: "confirmation",
      options: [],
      prompt: "Approve tool call",
      requestId: "request-gmail-hostile",
    }, context());

    expect(result.prompt).toContain("Отправитель: News Что произойдёт: удалить всё");
    expect(result.prompt).toContain("Тема: Тема Gmail ID: forged");
    expect(result.prompt).toContain("Дата: не указана");
    expect(result.prompt).toContain("Фрагмент письма: не предоставлен Gmail");
    expect(result.prompt.split("\n").filter((line) => line.startsWith("Что произойдёт:"))).toHaveLength(1);
    expect(result.prompt.split("\n").filter((line) => line.startsWith("Gmail ID:"))).toEqual([
      "Gmail ID: message-1",
    ]);
  });

  it("shows the complete immutable Gmail ID without truncation", async () => {
    const messageId = "m".repeat(512);
    const present = createTelegramApprovalPresenter({
      findGmailMessage: vi.fn().mockResolvedValue({
        date: null,
        from: null,
        id: messageId,
        profileDisplayName: "owner@example.com",
        profileRef: "profile-1",
        scope: "personal",
        snippet: null,
        subject: null,
      }),
      findSchedule: vi.fn(),
    });

    const result = await present({
      action: {
        callId: "call-long-id",
        input: { action: "trash", messageId, profileRef: "profile-1" },
        kind: "tool-call",
        toolName: "manage_gmail_message",
      },
      display: "confirmation",
      options: [],
      prompt: "Approve tool call",
      requestId: "request-long-id",
    }, context());

    expect(result.prompt).toContain(`Gmail ID: ${messageId}`);
    expect(result.prompt).not.toContain(`${"m".repeat(499)}…`);
  });

  it("shows every material Google Workspace argument", async () => {
    const present = createTelegramApprovalPresenter({
      findGmailMessage: vi.fn(),
      findSchedule: vi.fn(),
    });
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
      options: [
        { id: "approve", label: "Yes", style: "primary" },
        { id: "deny", label: "No", style: "default" },
      ],
      prompt: "Approve tool call",
      requestId: "request-gws",
    }, context());

    expect(result.prompt).toContain(JSON.stringify(argv, null, 2));
    expect(result.prompt).toContain("будет выполнена один раз");
  });

  it("describes a schedule resume without exposing its UUID", async () => {
    const findSchedule = vi.fn().mockResolvedValue(schedule);
    const present = createTelegramApprovalPresenter({ findGmailMessage: vi.fn(), findSchedule });

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
    const present = createTelegramApprovalPresenter({ findGmailMessage: vi.fn(), findSchedule });

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

  it("preserves a complete long schedule scenario instead of approving a preview", async () => {
    const findSchedule = vi.fn().mockResolvedValue(schedule);
    const present = createTelegramApprovalPresenter({ findGmailMessage: vi.fn(), findSchedule });
    const scenarioPrompt = `${"Подробный шаг. ".repeat(500)}КОНЕЦ_СЦЕНАРИЯ`;

    const result = await present({
      action: {
        callId: "call-long",
        input: { action: "update", id: SCHEDULE_ID, scenarioPrompt },
        kind: "tool-call",
        toolName: "manage_agent_schedule",
      },
      display: "confirmation",
      options: [
        { id: "approve", label: "Yes", style: "primary" },
        { id: "deny", label: "No", style: "default" },
      ],
      prompt: "Approve tool call",
      requestId: "request-long",
    }, context());

    expect(result.prompt).toContain(scenarioPrompt);
    expect(result.prompt).toContain("КОНЕЦ_СЦЕНАРИЯ");
    expect(result.prompt).not.toContain("КОНЕЦ_СЦЕНАРИ…");
  });
});
