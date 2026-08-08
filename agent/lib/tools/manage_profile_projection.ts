/**
 * Owner-only external self-profile projection policy tool.
 *
 * Export:
 * - `manage_profile_projection`: lists opaque group refs or updates one explicit opt-in policy.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { requirePrivateTelegramOwner } from "../family-context.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { profileProjectionPolicyRepository } from "../profile-projection-policy-repository.js";
import { requireToolApprovalEvidence } from "../require-tool-approval-evidence.js";

const GROUP_REF_PATTERN = /^grp_[0-9a-f]{32}$/u;

export default defineTool({
  approval: ({ toolInput }) => toolInput?.action === "update" ? "user-approval" : "not-applicable",
  description:
    "В личном чате владельца показать opaque refs внешних групп или явно включить/отключить self-проекцию одной группы.",
  inputSchema: z.object({
    action: z.enum(["list", "update"]),
    enabled: z.boolean().optional(),
    groupRef: z.string().regex(GROUP_REF_PATTERN).optional(),
  }).strict(),
  async execute(input, ctx) {
    requirePrivateTelegramOwner(ctx);
    const auth = requireMemoryAuthorization(ctx);
    if (input.action === "list") {
      if (input.enabled !== undefined || input.groupRef !== undefined) {
        throw new AppError(
          "AGENT_PROFILE_PROJECTION_INPUT_INVALID",
          "Для action=list не передавайте enabled или groupRef",
        );
      }
      return { policies: await profileProjectionPolicyRepository.list(auth) };
    }
    if (input.enabled === undefined || input.groupRef === undefined) {
      throw new AppError(
        "AGENT_PROFILE_PROJECTION_INPUT_INVALID",
        "Для action=update обязательны opaque groupRef и enabled",
      );
    }
    // Owner role and exact Telegram approval are both revalidated at the mutation boundary.
    await requireToolApprovalEvidence(ctx, "manage_profile_projection", input);
    return await profileProjectionPolicyRepository.update(auth, {
      enabled: input.enabled,
      groupRef: input.groupRef,
      operationKey: ctx.callId,
    });
  },
});
