/**
 * Owner-only external-group schedule tool tests.
 *
 * Constructs covered:
 * - Read-only status does not require approval and lists only owner-managed external schedules.
 * - Create requires approval and forwards an explicit destination, capability subset, and history window.
 * - Mutations use opaque schedule IDs and never accept model-selected family or group IDs.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  owner: vi.fn(),
}));

vi.mock("./agent-schedules/external-agent-schedule-repository.js", () => ({
  externalAgentScheduleRepository: {
    create: dependencies.create,
    list: dependencies.list,
  },
}));
vi.mock("./family-context.js", () => ({
  requirePrivateTelegramOwner: dependencies.owner,
}));

import manageExternalGroupSchedule from "./tools/manage_external_group_schedule.js";

const context = { callId: "call-1" } as ToolContext;

describe("manage_external_group_schedule", () => {
  beforeEach(() => {
    dependencies.create.mockReset();
    dependencies.list.mockReset();
    dependencies.owner.mockReset();
    dependencies.owner.mockReturnValue({ familyId: "family-1", userId: "owner-1" });
  });

  it("lists schedules without approval from the verified owner scope", async () => {
    dependencies.list.mockResolvedValue({ items: [], total: 0 });
    const input = { action: "status" } as const;

    expect(await manageExternalGroupSchedule.approval?.({ toolInput: input } as never))
      .toBe("not-applicable");
    await expect(manageExternalGroupSchedule.execute(input, context)).resolves.toEqual({
      items: [],
      total: 0,
    });
    expect(dependencies.list).toHaveBeenCalledWith({
      familyId: "family-1",
      requestedBy: "owner-1",
      telegramChatId: null,
    });
  });

  it("creates a weekly group automation with an explicit retained-history window", async () => {
    const input = {
      action: "create",
      capabilityAllowlist: ["send_workspace_file"],
      firstRunAt: "2026-08-17T09:00:00+03:00",
      historyWindowDays: 7,
      recurrence: { daysOfWeek: [1], interval: 1, kind: "weekly" },
      scenarioPrompt: "Прочитай весь снимок истории, подготовь HTML-выжимку и отправь файл в чат.",
      telegramChatId: "-1001234567890",
      timezone: "Europe/Moscow",
      title: "Недельная HTML-выжимка",
      userRequest: "Каждый понедельник присылай HTML-выжимку обсуждения за неделю",
    } as const;
    dependencies.create.mockResolvedValue({ id: "schedule-1", scope: "group" });

    expect(await manageExternalGroupSchedule.approval?.({ toolInput: input } as never))
      .toBe("user-approval");
    await manageExternalGroupSchedule.execute({
      ...input,
      capabilityAllowlist: [...input.capabilityAllowlist],
      recurrence: { ...input.recurrence, daysOfWeek: [...input.recurrence.daysOfWeek] },
    }, context);

    expect(dependencies.create).toHaveBeenCalledWith(
      { familyId: "family-1", requestedBy: "owner-1" },
      expect.objectContaining({
        capabilityAllowlist: ["send_workspace_file"],
        firstRunAt: new Date("2026-08-17T06:00:00.000Z"),
        historyWindowDays: 7,
        operationKey: "call-1",
        telegramChatId: "-1001234567890",
        timezone: "Europe/Moscow",
      }),
    );
  });

  it("publishes no model-selectable familyId, groupId, or Telegram chat type", () => {
    const schema = JSON.stringify(manageExternalGroupSchedule.inputSchema);

    expect(schema).not.toContain("familyId");
    expect(schema).not.toContain("groupId");
    expect(schema).not.toContain("telegramChatType");
  });
});
