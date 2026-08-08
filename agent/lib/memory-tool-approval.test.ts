/**
 * Memory tool approval policy regression tests.
 *
 * Constructs covered:
 * - Sensitive and private-to-family writes require confirmation.
 * - Group corrections avoid unsafe callback identity reuse and rely on repository author checks.
 */
import { describe, expect, it } from "vitest";

import manageMemory from "./tools/manage_memory.js";
import manageMemoryApproval from "./tools/manage_memory_approval.js";
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
  it("requires approval for sensitive writes and private family disclosure", () => {
    expect(approvalFor(remember, { scope: "personal", sensitivity: "sensitive" }, "private"))
      .toBe("user-approval");
    expect(approvalFor(remember, { scope: "family", sensitivity: "normal" }, "private"))
      .toBe("user-approval");
    expect(approvalFor(remember, { scope: "group", sensitivity: "normal" }, "group"))
      .toBe("not-applicable");
  });

  it("confirms every destructive memory mutation independently of chat type", () => {
    expect(approvalFor(manageMemory, { action: "delete" }, "private")).toBe("user-approval");
    expect(approvalFor(manageMemory, { action: "delete" }, "supergroup")).toBe("user-approval");
    expect(approvalFor(manageMemory, { action: "edit" }, "supergroup")).toBe("user-approval");
    expect(approvalFor(manageMemory, { action: "undo" }, "private")).toBe("not-applicable");
  });

  it("requires identity-bound HITL for sensitive decisions and thread lifecycle", () => {
    expect(approvalFor(manageMemoryApproval, { action: "approve" }, "private"))
      .toBe("user-approval");
    expect(approvalFor(manageMemoryApproval, { action: "reject" }, "supergroup"))
      .toBe("user-approval");
    expect(approvalFor(manageMemoryThread, { action: "complete" }, "private"))
      .toBe("user-approval");
    expect(approvalFor(manageMemoryThread, { action: "reactivate" }, "supergroup"))
      .toBe("user-approval");
  });
});
