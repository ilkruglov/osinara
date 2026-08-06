/**
 * Turn-scoped Eve skill visibility resolver.
 *
 * Exports:
 * - `createConversationSkillResolver`: injectable private/group skill-set resolver.
 * - `resolveConversationSkills`: production resolver using live PostgreSQL grants.
 */
import type { SessionAuth } from "eve/context";
import type { SkillDefinition } from "eve/skills";

import { AppError } from "../app-error.js";
import { resolveConversationEnvironment } from "../conversation-environment.js";
import { resolveExternalGroupSkillPolicy } from "../tool-policy/external-group-policy.js";
import { selectGroupSafeSkillDefinitions } from "./group-skill-definitions.js";
import type { GroupSafeSkillName } from "./group-skill-catalog.js";
import { groupSkillPolicyRepository } from "./group-skill-repository.js";
import { TRUSTED_GOOGLE_WORKSPACE_SKILL_DEFINITIONS } from "./trusted-google-workspace-skills.js";

interface ConversationSkillResolverDependencies {
  loadGroupSkillAllowlist(groupId: string): Promise<ReadonlySet<GroupSafeSkillName>>;
}

export function createConversationSkillResolver(
  dependencies: ConversationSkillResolverDependencies,
) {
  return async function resolveSkills(auth: SessionAuth): Promise<Record<string, SkillDefinition>> {
    const environment = resolveConversationEnvironment(auth);
    if (environment === "private") {
      return {
        ...TRUSTED_GOOGLE_WORKSPACE_SKILL_DEFINITIONS,
        ...selectGroupSafeSkillDefinitions(new Set<GroupSafeSkillName>(["pohuy"])),
      };
    }

    if (environment === "external") {
      return selectGroupSafeSkillDefinitions(resolveExternalGroupSkillPolicy(auth));
    }

    const groupId = auth.current?.attributes.groupId;
    if (typeof groupId !== "string") {
      throw new AppError(
        "AGENT_GROUP_SKILL_CONTEXT_INVALID",
        "Не удалось определить группу для загрузки skills",
      );
    }
    const granted = selectGroupSafeSkillDefinitions(
      await dependencies.loadGroupSkillAllowlist(groupId),
    );
    return { ...TRUSTED_GOOGLE_WORKSPACE_SKILL_DEFINITIONS, ...granted };
  };
}

export const resolveConversationSkills = createConversationSkillResolver({
  loadGroupSkillAllowlist: (groupId) =>
    groupSkillPolicyRepository.loadGroupSkillAllowlist(groupId),
});
