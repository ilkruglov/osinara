/**
 * Consolidated memory mutation routing tests.
 *
 * Constructs:
 * - `manage_memory.edit`: passes an opaque ref to the scoped repository boundary.
 * - Delete and undo actions reuse the authorized ref-based idempotent deletion boundary.
 * - Raw database UUIDs and the historical `id` field are rejected at the model boundary.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { deleteMemoryByRef, requireApprovalEvidence, updateMemoryByRef } = vi.hoisted(() => ({
  deleteMemoryByRef: vi.fn(),
  requireApprovalEvidence: vi.fn(),
  updateMemoryByRef: vi.fn(),
}));

vi.mock("./memory-context.js", () => ({
  requireMemoryAuthorization: () => ({ familyId: "family-1", scopes: ["personal"] }),
}));
vi.mock("./memory-repository.js", () => ({
  memoryRepository: { deleteByRef: deleteMemoryByRef, updateByRef: updateMemoryByRef },
}));
vi.mock("./require-tool-approval-evidence.js", () => ({
  requireToolApprovalEvidence: requireApprovalEvidence,
}));

import manageMemory from "./tools/manage_memory.js";

const MEMORY_REF = "mem_0123456789abcdef0123456789abcdef";
const context = {
  callId: "call-1",
  session: { auth: { current: { attributes: {
    telegramConversationId: "conversation-1",
    telegramTimelineEntryId: "timeline-entry-1",
  } } } },
} as unknown as ToolContext;

describe("manage_memory", () => {
  beforeEach(() => {
    deleteMemoryByRef.mockReset();
    requireApprovalEvidence.mockReset();
    requireApprovalEvidence.mockResolvedValue(undefined);
    updateMemoryByRef.mockReset();
  });

  it("passes only repository fields for an edit", async () => {
    updateMemoryByRef.mockResolvedValue({
      author: { status: "current_member", telegramUserId: null, userId: "user-1" },
      confirmation: "user_confirmed",
      content: "Исправлено",
      createdAt: "2026-08-01T10:00:00.000Z",
      embeddingStatus: "pending",
      id: "00000000-0000-4000-8000-000000000001",
      kind: "fact",
      memoryRef: MEMORY_REF,
      messageThreadId: null,
      scope: "personal",
      sensitivity: "normal",
      source: "eve:private-session:turn-1",
      updatedAt: "2026-08-01T11:00:00.000Z",
    });

    const result = await manageMemory.execute(
      { action: "edit", content: "Исправлено", memoryRef: MEMORY_REF },
      context,
    );

    expect(updateMemoryByRef).toHaveBeenCalledWith(
      { familyId: "family-1", scopes: ["personal"] },
      {
        content: "Исправлено",
        memoryRef: MEMORY_REF,
        operationKey: "call-1",
        source: { conversationId: "conversation-1", timelineEntryId: "timeline-entry-1" },
      },
    );
    expect(requireApprovalEvidence).toHaveBeenCalledWith(context, "manage_memory", {
      action: "edit", content: "Исправлено", memoryRef: MEMORY_REF,
    });
    expect(result).not.toHaveProperty("id");
    expect(result).not.toHaveProperty("source");
  });

  it.each(["delete", "undo"] as const)("routes %s through idempotent deletion", async (action) => {
    deleteMemoryByRef.mockResolvedValue({ deleted: true });

    await manageMemory.execute({ action, memoryRef: MEMORY_REF }, context);

    expect(deleteMemoryByRef).toHaveBeenCalledWith(
      { familyId: "family-1", scopes: ["personal"] },
      MEMORY_REF,
      "call-1",
    );
    expect(requireApprovalEvidence).toHaveBeenCalledTimes(action === "delete" ? 1 : 0);
  });

  it.each([
    { action: "delete", id: "00000000-0000-4000-8000-000000000001" },
    { action: "delete", memoryRef: "00000000-0000-4000-8000-000000000001" },
  ])("rejects raw memory UUID payloads: $action", async (input) => {
    await expect(manageMemory.execute(input, context)).rejects.toThrowError(
      /AGENT_MEMORY_INPUT_INVALID/,
    );
    expect(deleteMemoryByRef).not.toHaveBeenCalled();
  });
});
