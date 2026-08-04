/**
 * Live PostgreSQL group skill policy lookup.
 *
 * Exports:
 * - `GroupSkillPolicyRepository`: injectable exact-group allowlist contract.
 * - `groupSkillPolicyRepository`: fail-closed production implementation.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import {
  parseGroupSkillAllowlist,
  type GroupSafeSkillName,
} from "./group-skill-catalog.js";

export interface GroupSkillPolicyRepository {
  loadGroupSkillAllowlist(groupId: string): Promise<ReadonlySet<GroupSafeSkillName>>;
}

export const groupSkillPolicyRepository: GroupSkillPolicyRepository = {
  async loadGroupSkillAllowlist(groupId) {
    const result = await database().query<{ skill_allowlist: string[] }>(
      "SELECT skill_allowlist FROM telegram_groups WHERE id = $1",
      [groupId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new AppError(
        "AGENT_GROUP_SKILL_POLICY_NOT_FOUND",
        "Не удалось найти актуальную политику skills этой группы",
      );
    }
    const allowed = parseGroupSkillAllowlist(row.skill_allowlist);
    if (!allowed) {
      throw new AppError(
        "AGENT_GROUP_SKILL_POLICY_INVALID",
        "Политика skills группы повреждена. Обратитесь к владельцу агента",
      );
    }
    return allowed;
  },
};
