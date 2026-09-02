/**
 * Live-authorized Eve `load_skill` wrapper for external Telegram groups.
 *
 * Exports:
 * - `createExternalGroupLoadSkillTool`: injectable Eve-branded wrapper for authorization tests.
 * - `externalGroupLoadSkillTool`: production `defineTool` wrapper over Eve's native skill loader.
 */
import { defineTool, type ToolContext, type ToolDefinition } from "eve/tools";
import { loadSkill } from "eve/tools/defaults";

import { AppError } from "../app-error.js";
import { IMAGE_GENERATION_AVAILABLE } from "../image-generation/image-generation-availability.js";
import { isImageGenerationSkillName } from "../image-generation/image-generation-skill.js";
import { authorizeCurrentExternalGroupCapability } from "../tool-policy/external-group-live-policy.js";
import { resolveExternalGroupPolicyIdentity } from "../tool-policy/external-group-policy.js";

type AnyToolDefinition = ToolDefinition<any, any>;

interface ExternalGroupLoadSkillDependencies {
  authorizeImageGeneration(ctx: ToolContext): Promise<void>;
  executeNative(input: unknown, ctx: ToolContext): Promise<unknown>;
}

function forbidden(): AppError {
  return new AppError(
    "AGENT_GROUP_SKILL_FORBIDDEN",
    "Этот skill не разрешён в текущей группе. Обратитесь к владельцу агента",
  );
}

export function createExternalGroupLoadSkillTool(
  dependencies: ExternalGroupLoadSkillDependencies,
): AnyToolDefinition {
  return defineTool({
    ...(loadSkill as AnyToolDefinition),
    async execute(input, ctx) {
      const skill = (input as { skill?: unknown } | null)?.skill;
      if (typeof skill !== "string" || !isImageGenerationSkillName(skill)) throw forbidden();

      // Image instructions are coupled to the tool grant, so the owner changes only one policy.
      // A grant persisted under a previous model provider must not resurrect the skill, so the
      // provider gate is re-checked here rather than trusting the turn-scoped skill manifest.
      if (isImageGenerationSkillName(skill)) {
        if (!IMAGE_GENERATION_AVAILABLE) throw forbidden();
        await dependencies.authorizeImageGeneration(ctx);
        return await dependencies.executeNative(input, ctx);
      }
      throw forbidden();
    },
  });
}

const nativeLoadSkill = loadSkill as AnyToolDefinition;
export const externalGroupLoadSkillTool = createExternalGroupLoadSkillTool({
  authorizeImageGeneration: async (ctx) => {
    const identity = resolveExternalGroupPolicyIdentity(ctx.session.auth);
    if (!identity) throw forbidden();
    await authorizeCurrentExternalGroupCapability(identity, "generate_image");
  },
  executeNative: (input, ctx) => nativeLoadSkill.execute(input, ctx),
});
