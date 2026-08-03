/**
 * Telegram group status tool tests.
 *
 * Constructs covered:
 * - `manage_telegram_group.status` reads every family registration without HITL.
 * - Mutating actions retain user approval.
 * - External status distinguishes configured grants from always-available workspace tools.
 * - Permanent guidance requires reading status before an uncertain policy replacement.
 */
import { readFile } from "node:fs/promises";
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listStatuses } = vi.hoisted(() => ({ listStatuses: vi.fn() }));

vi.mock("./telegram-group-administration-repository.js", () => ({
  telegramGroupAdministrationRepository: {
    listStatuses,
    registerGroup: vi.fn(),
    removeRegistration: vi.fn(),
    updatePolicy: vi.fn(),
  },
}));

import manageTelegramGroup from "../tools/manage_telegram_group.js";

const INSTRUCTIONS_PATH = new URL("../instructions.md", import.meta.url);

function context(): ToolContext {
  const caller = {
    attributes: {
      familyId: "family-1",
      memoryScopes: ["personal", "family"],
      role: "owner",
      telegramChatId: "101",
      telegramChatType: "private",
    },
    authenticator: "telegram",
    principalId: "owner-1",
    principalType: "user" as const,
  };
  return {
    session: {
      auth: { current: caller, initiator: caller },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
  } as unknown as ToolContext;
}

function approvalFor(input: Record<string, unknown>) {
  const approval = (manageTelegramGroup as unknown as {
    approval: (context: { toolInput: Record<string, unknown> }) => unknown;
  }).approval;
  return approval({ toolInput: input });
}

describe("manage_telegram_group.status", () => {
  beforeEach(() => {
    listStatuses.mockReset();
    listStatuses.mockResolvedValue([
      {
        messageMode: "owner_only",
        telegramChatId: "-1002",
        title: "Внешняя",
        toolAllowlist: ["search_memories"],
        type: "external",
      },
      {
        messageMode: "all",
        telegramChatId: "-1001",
        title: "Семья",
        toolAllowlist: [],
        type: "family_private",
      },
    ]);
  });

  it("returns every configured policy in one read-only result", async () => {
    await expect(manageTelegramGroup.execute({ action: "status" }, context())).resolves.toEqual({
      groups: [
        expect.objectContaining({
          builtInWorkspaceTools: ["glob", "grep", "read_file", "write_file"],
          effectiveConfiguredTools: ["glob", "grep", "read_file", "write_file", "search_memories"],
          policySummary: "Базовые workspace tools плюс полный настроенный allowlist внешней группы.",
          toolAccessMode: "external_allowlist",
          toolAllowlist: ["search_memories"],
        }),
        expect.objectContaining({
          builtInWorkspaceTools: [],
          policySummary: "Инструменты назначаются семейным режимом; отдельный allowlist не настраивается.",
          toolAccessMode: "family_policy",
          toolAllowlist: [],
        }),
      ],
      total: 2,
    });
    expect(listStatuses).toHaveBeenCalledWith({ familyId: "family-1", requestedBy: "owner-1" });
  });

  it("skips HITL only for status", () => {
    expect(approvalFor({ action: "status" })).toBe("not-applicable");
    expect(approvalFor({ action: "update_policy" })).toBe("user-approval");
    expect(approvalFor({ action: "remove" })).toBe("user-approval");
    expect(approvalFor({ action: "register" })).toBe("user-approval");
  });

  it("requires status before replacing an unknown current policy", async () => {
    const instructions = await readFile(INSTRUCTIONS_PATH, "utf8");

    expect(instructions).toContain("Перед `update_policy` сначала вызови `manage_telegram_group`");
    expect(instructions).toContain("`{\"action\":\"status\"}`");
    expect(instructions).toContain("команду `/status`");
    expect(instructions).toContain("одним сообщением");
  });
});
