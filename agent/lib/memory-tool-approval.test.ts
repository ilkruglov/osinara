/**
 * Memory tool approval policy regression tests.
 *
 * Constructs covered:
 * - Sensitive and private-to-family writes require confirmation.
 * - Group corrections avoid unsafe callback identity reuse and rely on repository author checks.
 */
import { describe, expect, it, vi } from "vitest";

const { canUndoCreate } = vi.hoisted(() => ({ canUndoCreate: vi.fn() }));

vi.mock("./memory-context.js", () => ({
  requireMemoryAuthorization: () => ({ familyId: "family-1", scopes: ["personal"] }),
  requireWritableScope: (_authorization: unknown, scope: unknown) => scope,
}));
vi.mock("./memory-repository.js", () => ({
  memoryRepository: { canUndoCreate, create: vi.fn(), delete: vi.fn(), undoCreate: vi.fn(), update: vi.fn() },
}));

import manageMemory from "./tools/manage_memory.js";
import remember from "./tools/remember.js";

function approvalFor(tool: unknown, input: Record<string, unknown>, chatType: string) {
  const approval = (tool as { approval: (context: unknown) => unknown }).approval;
  return approval({
    approvedTools: [],
    callId: "call-1",
    session: {
      auth: {
        current: {
          attributes: { telegramChatType: chatType },
          principalId: "user-1",
          principalType: "user",
        },
      },
      id: "session-1",
      turn: { id: "turn-1" },
    },
    toolInput: input,
    toolName: "memory-tool",
  });
}

describe("memory tool approvals", () => {
  it("requires approval for sensitive writes and private family disclosure", () => {
    expect(approvalFor(remember, { scope: "personal", sensitivity: "sensitive" }, "private"))
      .toBe("user-approval");
    expect(approvalFor(remember, { scope: "family", sensitivity: "normal" }, "private"))
      .toBe("user-approval");
    expect(approvalFor(remember, { scope: "group", sensitivity: "normal" }, "group"))
      .toBe("not-applicable");
  });

  it("confirms private mutations but executes addressed group mutations under SQL author checks", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(await approvalFor(manageMemory, { action: "delete", id }, "private"))
      .toBe("user-approval");
    expect(await approvalFor(
      manageMemory,
      { action: "edit", content: "Исправлено", id },
      "supergroup",
    )).toBe("not-applicable");
  });
});
