/**
 * Explicit HITL claim-conflict resolution tool.
 *
 * Export:
 * - `manage_memory_conflict`: chooses one version, keeps both, or records an unresolved decision.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { memoryConflictRepository } from "../memory-conflict-repository.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { MEMORY_REF_PATTERN } from "../model-memory.js";
import { AppError } from "../app-error.js";
import { requireToolApprovalEvidence } from "../require-tool-approval-evidence.js";

const conflictInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("choose"),
    conflictRef: z.string(),
    memoryRef: z.string(),
  }).strict(),
  z.object({
    action: z.enum(["keep_both", "keep_unresolved"]),
    conflictRef: z.string(),
  }).strict(),
]);
const CONFLICT_REF_PATTERN = /^conf_[0-9a-f]{32}$/u;

function invalidInput(): AppError {
  return new AppError(
    "AGENT_MEMORY_CONFLICT_INPUT_INVALID",
    "Передайте explicit action и безопасные conflictRef/memoryRef из блока конфликта",
  );
}

export default defineTool({
  approval: () => "user-approval",
  description: [
    "Разрешить показанный конфликт памяти только по явному решению пользователя.",
    "choose требует conflictRef и memoryRef выбранной версии; keep_both сохраняет обе версии;",
    "keep_unresolved фиксирует решение пока не выбирать. Никогда не выбирай версию самостоятельно.",
  ].join(" "),
  inputSchema: conflictInputSchema,
  async execute(input, ctx) {
    const parsed = conflictInputSchema.safeParse(input);
    if (!parsed.success || !CONFLICT_REF_PATTERN.test(parsed.data.conflictRef)) throw invalidInput();
    if (parsed.data.action === "choose" && !MEMORY_REF_PATTERN.test(parsed.data.memoryRef)) {
      throw invalidInput();
    }
    // Conflict resolution is consequential even when both claims remain, so bind every action.
    await requireToolApprovalEvidence(ctx, "manage_memory_conflict", input);
    return await memoryConflictRepository.resolve(requireMemoryAuthorization(ctx), {
      ...parsed.data,
      operationKey: ctx.callId,
    });
  },
});
