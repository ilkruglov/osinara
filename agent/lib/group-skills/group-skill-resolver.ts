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
import { GROUP_SAFE_SKILL_DEFINITIONS } from "./group-skill-definitions.js";
import type { GroupSafeSkillName } from "./group-skill-catalog.js";
import { groupSkillPolicyRepository } from "./group-skill-repository.js";

interface ConversationSkillResolverDependencies {
  loadGroupSkillAllowlist(groupId: string): Promise<ReadonlySet<GroupSafeSkillName>>;
}

function selectedSkillDefinitions(
  names: ReadonlySet<GroupSafeSkillName>,
): Record<string, SkillDefinition> {
  return Object.fromEntries(
    [...names].map((name) => [name, GROUP_SAFE_SKILL_DEFINITIONS[name]]),
  );
}

export function createConversationSkillResolver(
  dependencies: ConversationSkillResolverDependencies,
) {
  return async function resolveSkills(auth: SessionAuth): Promise<Record<string, SkillDefinition>> {
    const environment = resolveConversationEnvironment(auth);
    if (environment === "private") {
      return selectedSkillDefinitions(new Set<GroupSafeSkillName>(["pohuy"]));
    }

    const groupId = auth.current?.attributes.groupId;
    if (typeof groupId !== "string") {
      throw new AppError(
        "AGENT_GROUP_SKILL_CONTEXT_INVALID",
        "Не удалось определить группу для загрузки skills",
      );
    }
    return selectedSkillDefinitions(await dependencies.loadGroupSkillAllowlist(groupId));
  };
}

export const resolveConversationSkills = createConversationSkillResolver({
  loadGroupSkillAllowlist: (groupId) =>
    groupSkillPolicyRepository.loadGroupSkillAllowlist(groupId),
});
