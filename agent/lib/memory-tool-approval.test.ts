/**
 * Memory tool approval policy regression tests.
 *
 * Constructs covered:
 * - Sensitive and private-to-family writes require direct tool confirmation.
 * - Every destructive mutation requires HITL; immediate undo requires durable provenance instead.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { canUndoCreate } = vi.hoisted(() => ({ canUndoCreate: vi.fn() }));

vi.mock("./memory-context.js", () => ({
  requireMemoryAuthorization: () => ({ familyId: "family-1", scopes: ["personal"] }),
  requireWritableScope: (_authorization: unknown, scope: unknown) => scope,
}));
vi.mock("./memory-repository.js", () => ({
  memoryRepository: {
    canUndoCreate,
    create: vi.fn(),
    deleteByRef: vi.fn(),
    undoCreate: vi.fn(),
    updateByRef: vi.fn(),
  },
}));

import manageMemory from "./tools/manage_memory.js";
import manageMemoryThread from "./tools/manage_memory_thread.js";
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
  beforeEach(() => {
    canUndoCreate.mockReset();
  });

  it("requires approval for sensitive writes and private family disclosure", () => {
    expect(approvalFor(remember, { scope: "personal", sensitivity: "sensitive" }, "private"))
      .toBe("user-approval");
    expect(approvalFor(remember, { scope: "family", sensitivity: "normal" }, "private"))
      .toBe("user-approval");
    expect(approvalFor(remember, { scope: "group", sensitivity: "normal" }, "group"))
      .toBe("not-applicable");
  });

  it("confirms every destructive memory mutation independently of chat type", async () => {
    const memoryRef = "mem_0123456789abcdef0123456789abcdef";
    expect(await approvalFor(manageMemory, { action: "delete", memoryRef }, "private"))
      .toBe("user-approval");
    expect(await approvalFor(manageMemory, { action: "delete", memoryRef }, "supergroup"))
      .toBe("user-approval");
    expect(await approvalFor(
      manageMemory,
      { action: "edit", content: "Исправлено", memoryRef },
      "supergroup",
    )).toBe("user-approval");

    canUndoCreate.mockResolvedValue(true);
    expect(await approvalFor(manageMemory, { action: "undo", memoryRef }, "private"))
      .toBe("not-applicable");
  });

  it("requires identity-bound HITL for thread lifecycle", () => {
    expect(approvalFor(manageMemoryThread, { action: "complete" }, "private"))
      .toBe("user-approval");
    expect(approvalFor(manageMemoryThread, { action: "reactivate" }, "supergroup"))
      .toBe("user-approval");
  });
});
