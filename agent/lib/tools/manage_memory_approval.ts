/**
 * Sensitive memory approval tool.
 *
 * Export:
 * - `manage_memory_approval`: approves or rejects one opaque pending candidate exactly once.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireMemoryAuthorization } from "../memory-context.js";
import { memorySensitiveApprovalRepository } from "../memory-sensitive-approval-repository.js";
import { requireToolApprovalEvidence } from "../require-tool-approval-evidence.js";

const APPROVAL_REF_PATTERN = /^approval_[0-9a-f]{32}$/u;

export default defineTool({
  approval: () => "user-approval",
  description:
    "Явно подтвердить или отклонить чувствительный candidate памяти по opaque approvalRef из notice.",
  inputSchema: z.object({
    action: z.enum(["approve", "reject"]),
    approvalRef: z.string().regex(APPROVAL_REF_PATTERN),
  }).strict(),
  async execute(input, ctx) {
    await requireToolApprovalEvidence(ctx, "manage_memory_approval", input);
    return await memorySensitiveApprovalRepository.resolve(requireMemoryAuthorization(ctx), {
      ...input,
      operationKey: ctx.callId,
    });
  },
});
