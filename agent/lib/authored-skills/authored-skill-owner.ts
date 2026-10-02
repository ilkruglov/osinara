/**
 * Owner check shared by every authored-skill mutation.
 *
 * Export:
 * - `requireCurrentOwner`: the caller's role attribute is only a precondition; the owner role is
 *   re-read from `family_memberships` inside the mutation's transaction.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import type { FamilyCaller } from "../family-context.js";
import { lockCurrentOwner } from "../family-repository-checks.js";

export async function requireCurrentOwner(client: PoolClient, caller: FamilyCaller): Promise<void> {
  if (caller.role !== "owner") {
    throw new AppError("AGENT_SKILL_FORBIDDEN", "Создавать и менять навыки может только владелец семьи");
  }
  if (!await lockCurrentOwner(client, caller.familyId, caller.userId)) {
    throw new AppError(
      "AGENT_SKILL_FORBIDDEN",
      "Права владельца больше не действуют. Обновите чат и повторите действие",
    );
  }
}
