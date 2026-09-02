/**
 * External-group reminder tool contract tests.
 *
 * Constructs covered:
 * - Malformed model payloads stop in the approval policy, before HITL and before any write.
 * - Action routing: pause and resume become one enabled flag, delete carries the Eve call id.
 * - The group descriptor knows no scope or timezone field, so neither can reach the repository.
 * - Deletion carries the live Telegram presence lookup that decides the author-left case.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({
  create: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
}));
const authorization = vi.hoisted(() => ({ requireGroupReminderAuthorization: vi.fn() }));
const presence = vi.hoisted(() => ({ telegramChatMemberPresence: vi.fn() }));

vi.mock("../reminders/group-reminder-repository.js", () => ({
  groupReminderRepository: repository,
}));
vi.mock("../reminders/group-reminder-context.js", () => ({
  requireGroupReminderAuthorization: authorization.requireGroupReminderAuthorization,
}));
vi.mock("../telegram-chat-membership.js", () => ({
  telegramChatMemberPresence: presence.telegramChatMemberPresence,
}));

const { EXTERNAL_GROUP_REMINDER_TOOLS } = await import("./external-group-reminder-tools.js");

const REMINDER_ID = "00000000-0000-4000-8000-000000000001";
const AUTH = {
  familyId: "family-1",
  groupId: "group-1",
  telegramChatId: "-1001",
  telegramUserId: "77",
};
const context = { callId: "call-1" } as never;

const manageReminder = EXTERNAL_GROUP_REMINDER_TOOLS.manage_reminder!;
const listReminders = EXTERNAL_GROUP_REMINDER_TOOLS.list_reminders!;

function approve(toolInput: unknown): unknown {
  const approval = manageReminder.approval as (ctx: never) => unknown;
  return approval({
    approvedTools: new Set(),
    callId: "call-1",
    session: {} as never,
    toolInput,
    toolName: "manage_reminder",
  } as never);
}

describe("external group reminder tools", () => {
  beforeEach(() => {
    repository.create.mockReset();
    repository.delete.mockReset();
    repository.list.mockReset();
    repository.update.mockReset();
    authorization.requireGroupReminderAuthorization.mockReset();
    authorization.requireGroupReminderAuthorization.mockReturnValue(AUTH);
  });

  it("requests one approval for a complete create payload", () => {
    expect(approve({
      action: "create",
      content: "Созвон по проекту",
      firstRunAt: "2026-09-04T18:00:00+03:00",
      recurrence: null,
    })).toBe("user-approval");
  });

  it("rejects an incomplete payload before approval and before any write", () => {
    expect(() => approve({ action: "create", firstRunAt: "2026-09-04T18:00:00+03:00", recurrence: null }))
      .toThrowError(/AGENT_REMINDER_INPUT_INVALID/u);
    expect(repository.create).not.toHaveBeenCalled();
    expect(authorization.requireGroupReminderAuthorization).not.toHaveBeenCalled();
  });

  it("knows no scope or timezone field, so a trusted payload shape is refused", async () => {
    await expect(manageReminder.execute({
      action: "create",
      content: "Созвон по проекту",
      firstRunAt: "2026-09-04T18:00:00+03:00",
      recurrence: null,
      scope: "group",
      timezone: "Europe/Moscow",
    } as never, context)).rejects.toThrowError(/AGENT_REMINDER_INPUT_INVALID/u);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("creates a reminder under the verified author with the Eve call id as replay key", async () => {
    repository.create.mockResolvedValue({ id: REMINDER_ID, scope: "group" });

    await expect(manageReminder.execute({
      action: "create",
      content: "Созвон по проекту",
      firstRunAt: "2026-09-04T18:00:00+03:00",
      recurrence: { interval: 1, unit: "weekly" },
    } as never, context)).resolves.toEqual({ id: REMINDER_ID, scope: "group" });

    expect(repository.create).toHaveBeenCalledWith(AUTH, {
      content: "Созвон по проекту",
      firstRunAt: new Date("2026-09-04T18:00:00+03:00"),
      operationKey: "call-1",
      recurrence: { interval: 1, unit: "weekly" },
    });
  });

  it.each([
    ["pause", false],
    ["resume", true],
  ])("routes %s to one enabled flag", async (action, enabled) => {
    repository.update.mockResolvedValue({ id: REMINDER_ID });

    await manageReminder.execute({ action, id: REMINDER_ID } as never, context);

    expect(repository.update).toHaveBeenCalledWith(AUTH, REMINDER_ID, {
      enabled,
      operationKey: "call-1",
    });
  });

  it("passes only the requested changes to an update", async () => {
    repository.update.mockResolvedValue({ id: REMINDER_ID });

    await manageReminder.execute({ action: "update", content: "Новый текст", id: REMINDER_ID } as never, context);

    expect(repository.update).toHaveBeenCalledWith(AUTH, REMINDER_ID, {
      content: "Новый текст",
      operationKey: "call-1",
    });
  });

  it("reports a deletion and hands the live presence lookup to the boundary", async () => {
    repository.delete.mockResolvedValue(true);

    await expect(manageReminder.execute({ action: "delete", id: REMINDER_ID } as never, context))
      .resolves.toEqual({ deleted: true });
    // The author-left rule is decided inside the repository, so it must receive the real lookup.
    expect(repository.delete).toHaveBeenCalledWith(
      AUTH,
      REMINDER_ID,
      "call-1",
      presence.telegramChatMemberPresence,
    );
  });

  it("lists the chat reminders of the verified author's chat", async () => {
    repository.list.mockResolvedValue({ items: [], nextCursor: null });

    await expect(listReminders.execute({ limit: 100 } as never, context))
      .resolves.toEqual({ items: [], nextCursor: null });
    expect(repository.list).toHaveBeenCalledWith(AUTH, { limit: 100 });
  });
});
