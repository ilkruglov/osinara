/**
 * Consolidated memory mutation routing tests.
 *
 * Constructs:
 * - `manage_memory.edit`: strips the model-facing discriminator before repository hashing.
 * - Delete and immediate undo use distinct repository boundaries.
 * - Approval and execution share one strict action parser.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { canUndoMemory, deleteMemory, undoMemory, updateMemory } = vi.hoisted(() => ({
  canUndoMemory: vi.fn(),
  deleteMemory: vi.fn(),
  undoMemory: vi.fn(),
  updateMemory: vi.fn(),
}));

vi.mock("./memory-context.js", () => ({
  requireMemoryAuthorization: () => ({ familyId: "family-1", scopes: ["personal"] }),
}));
vi.mock("./memory-repository.js", () => ({
  memoryRepository: {
    canUndoCreate: canUndoMemory,
    delete: deleteMemory,
    undoCreate: undoMemory,
    update: updateMemory,
  },
}));

import manageMemory from "./tools/manage_memory.js";

const ID = "00000000-0000-4000-8000-000000000001";
const context = {
  callId: "call-1",
  session: {
    auth: {
      current: {
        attributes: { telegramChatType: "private" },
        principalId: "user-1",
        principalType: "user",
      },
    },
    id: "session-1",
    turn: { id: "turn-1" },
  },
} as unknown as ToolContext;

function approvalFor(input: Record<string, unknown>, chatType = "private") {
  const approval = manageMemory.approval!;
  return approval({
    approvedTools: new Set(),
    callId: "call-1",
    session: {
      ...context.session,
      auth: {
        current: {
          attributes: { telegramChatType: chatType },
          principalId: "user-1",
          principalType: "user",
        },
      },
    },
    toolInput: input,
    toolName: "manage_memory",
  } as never);
}

describe("manage_memory", () => {
  beforeEach(() => {
    canUndoMemory.mockReset();
    deleteMemory.mockReset();
    undoMemory.mockReset();
    updateMemory.mockReset();
  });

  it("requires a published action enum in the model schema", () => {
    const schema = z.toJSONSchema(manageMemory.inputSchema as z.ZodType) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };

    expect(schema.required).toContain("action");
    expect(schema.properties?.action).toMatchObject({ enum: ["edit", "delete", "undo"] });
  });

  it("rejects malformed edit before showing private approval", async () => {
    await expect(approvalFor({ action: "edit", id: ID })).rejects.toThrowError(
      /AGENT_MEMORY_INPUT_INVALID: Поле content обязательно/u,
    );
    expect(canUndoMemory).not.toHaveBeenCalled();
  });

  it.each(["edit", "delete"] as const)("shows private approval before %s", async (action) => {
    const input = action === "edit"
      ? { action, content: "Исправлено", id: ID }
      : { action, id: ID };

    await expect(approvalFor(input)).resolves.toBe("user-approval");
  });

  it("allows undo without HITL only when repository proves immediate provenance", async () => {
    canUndoMemory.mockResolvedValue(true);

    await expect(approvalFor({ action: "undo", id: ID })).resolves.toBe("not-applicable");
    expect(canUndoMemory).toHaveBeenCalledWith(
      { familyId: "family-1", scopes: ["personal"] },
      ID,
      { sessionId: "session-1", turnId: "turn-1" },
    );
  });

  it("explicitly denies undo when durable provenance is not proven", async () => {
    canUndoMemory.mockResolvedValue(false);

    await expect(approvalFor({ action: "undo", id: ID }, "supergroup")).resolves.toMatchObject({
      type: "denied",
      reason: expect.stringMatching(/^AGENT_MEMORY_UNDO_DENIED:/u),
    });
  });

  it("passes only repository fields for an edit", async () => {
    updateMemory.mockResolvedValue({ id: ID });

    await manageMemory.execute({ action: "edit", content: "Исправлено", id: ID }, context);

    expect(updateMemory).toHaveBeenCalledWith(
      { familyId: "family-1", scopes: ["personal"] },
      { content: "Исправлено", id: ID, operationKey: "call-1" },
    );
  });

  it("routes delete through idempotent deletion", async () => {
    deleteMemory.mockResolvedValue({ deleted: true });

    await manageMemory.execute({ action: "delete", id: ID }, context);

    expect(deleteMemory).toHaveBeenCalledWith(
      { familyId: "family-1", scopes: ["personal"] },
      ID,
      "call-1",
    );
  });

  it("routes undo through the provenance-enforcing repository boundary", async () => {
    undoMemory.mockResolvedValue({ deleted: true });

    await manageMemory.execute({ action: "undo", id: ID }, context);

    expect(undoMemory).toHaveBeenCalledWith(
      { familyId: "family-1", scopes: ["personal"] },
      ID,
      {
        operationKey: "call-1",
        sessionId: "session-1",
        turnId: "turn-1",
      },
    );
    expect(deleteMemory).not.toHaveBeenCalled();
  });
});
