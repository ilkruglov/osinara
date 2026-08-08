/**
 * Model-facing conflict resolution tool tests.
 *
 * Constructs covered:
 * - Only opaque conflict/memory refs cross the tool boundary.
 * - Explicit choose, keep_both, and keep_unresolved actions route to one replay-safe repository.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireApprovalEvidence, resolveConflict } = vi.hoisted(() => ({
  requireApprovalEvidence: vi.fn(),
  resolveConflict: vi.fn(),
}));

vi.mock("./memory-context.js", () => ({
  requireMemoryAuthorization: () => ({ familyId: "family-1", scopes: ["personal"] }),
}));
vi.mock("./memory-conflict-repository.js", () => ({
  memoryConflictRepository: { resolve: resolveConflict },
}));
vi.mock("./require-tool-approval-evidence.js", () => ({
  requireToolApprovalEvidence: requireApprovalEvidence,
}));

import manageMemoryConflict from "./tools/manage_memory_conflict.js";

const CONFLICT_REF = "conf_0123456789abcdef0123456789abcdef";
const MEMORY_REF = "mem_0123456789abcdef0123456789abcdef";
const context = { callId: "conflict-call-1" } as ToolContext;

describe("manage_memory_conflict", () => {
  beforeEach(() => {
    requireApprovalEvidence.mockReset();
    requireApprovalEvidence.mockResolvedValue(undefined);
    resolveConflict.mockReset();
  });

  it("routes an explicit winner without database IDs", async () => {
    resolveConflict.mockResolvedValue({
      conflictRef: CONFLICT_REF,
      resolution: "chosen",
      chosenMemoryRef: MEMORY_REF,
    });

    const result = await manageMemoryConflict.execute({
      action: "choose",
      conflictRef: CONFLICT_REF,
      memoryRef: MEMORY_REF,
    }, context);

    expect(resolveConflict).toHaveBeenCalledWith(
      { familyId: "family-1", scopes: ["personal"] },
      { action: "choose", conflictRef: CONFLICT_REF, memoryRef: MEMORY_REF, operationKey: "conflict-call-1" },
    );
    expect(requireApprovalEvidence).toHaveBeenCalledWith(context, "manage_memory_conflict", {
      action: "choose", conflictRef: CONFLICT_REF, memoryRef: MEMORY_REF,
    });
    expect(requireApprovalEvidence.mock.invocationCallOrder[0])
      .toBeLessThan(resolveConflict.mock.invocationCallOrder[0]!);
    expect(JSON.stringify(result)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-/iu);
  });

  it.each(["keep_both", "keep_unresolved"] as const)("routes %s without a memory ref", async (action) => {
    resolveConflict.mockResolvedValue({ conflictRef: CONFLICT_REF, resolution: action });

    await manageMemoryConflict.execute({ action, conflictRef: CONFLICT_REF }, context);

    expect(resolveConflict).toHaveBeenCalledWith(
      { familyId: "family-1", scopes: ["personal"] },
      { action, conflictRef: CONFLICT_REF, operationKey: "conflict-call-1" },
    );
  });

  it("rejects raw conflict UUIDs before repository access", async () => {
    await expect(manageMemoryConflict.execute({
      action: "keep_both",
      conflictRef: "00000000-0000-4000-8000-000000000001",
    }, context)).rejects.toThrowError(/AGENT_MEMORY_CONFLICT_INPUT_INVALID/u);
    expect(resolveConflict).not.toHaveBeenCalled();
  });
});
