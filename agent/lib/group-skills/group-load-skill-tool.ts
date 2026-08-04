/**
 * Live-authorized Eve `load_skill` wrapper for external Telegram groups.
 *
 * Exports:
 * - `createExternalGroupLoadSkillTool`: injectable wrapper for isolated authorization tests.
 * - `externalGroupLoadSkillTool`: production wrapper over Eve's native skill loader.
 */
import { type ToolContext, type ToolDefinition } from "eve/tools";
import { loadSkill } from "eve/tools/defaults";

import { AppError } from "../app-error.js";
import { isGroupSafeSkillName, type GroupSafeSkillName } from "./group-skill-catalog.js";
import { groupSkillPolicyRepository } from "./group-skill-repository.js";

type AnyToolDefinition = ToolDefinition<any, any>;

interface ExternalGroupLoadSkillDependencies {
  executeNative(input: unknown, ctx: ToolContext): Promise<unknown>;
  loadGroupSkillAllowlist(groupId: string): Promise<ReadonlySet<GroupSafeSkillName>>;
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
  return {
    ...(loadSkill as AnyToolDefinition),
    async execute(input, ctx) {
      const skill = (input as { skill?: unknown } | null)?.skill;
      const groupId = ctx.session.auth.current?.attributes.groupId;
      if (typeof skill !== "string" || !isGroupSafeSkillName(skill)) throw forbidden();
      if (typeof groupId !== "string") {
        throw new AppError(
          "AGENT_GROUP_SKILL_CONTEXT_INVALID",
          "Не удалось определить группу для загрузки skill. Отправьте сообщение ещё раз",
        );
      }

      // Re-read after model planning so revocation wins over a stale turn-scoped descriptor.
      const allowed = await dependencies.loadGroupSkillAllowlist(groupId);
      if (!allowed.has(skill)) throw forbidden();
      return await dependencies.executeNative(input, ctx);
    },
  };
}

const nativeLoadSkill = loadSkill as AnyToolDefinition;
export const externalGroupLoadSkillTool = createExternalGroupLoadSkillTool({
  executeNative: (input, ctx) => nativeLoadSkill.execute(input, ctx),
  loadGroupSkillAllowlist: (groupId) =>
    groupSkillPolicyRepository.loadGroupSkillAllowlist(groupId),
});
