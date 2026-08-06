/**
 * Live PostgreSQL authorization for Google Workspace profile operations.
 *
 * Exports:
 * - `GoogleWorkspaceActor`: trusted workspace identity required by repository checks.
 * - `assertGoogleWorkspaceAccess`: validates current personal/family access and management role.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import type { FamilyRole } from "../family-access.js";
import type { GoogleIntegrationAuthorization } from "./google-integration-contract.js";

export type GoogleWorkspaceActor = Pick<
  GoogleIntegrationAuthorization,
  "familyId" | "scope" | "userId" | "workspaceId"
>;

export async function assertGoogleWorkspaceAccess(
  client: PoolClient,
  auth: GoogleWorkspaceActor,
  management: boolean,
): Promise<void> {
  // Membership and workspace ownership are read live in the same DB boundary as the operation.
  const result = await client.query<{
    owner_user_id: string | null;
    role: FamilyRole;
    scope: "family" | "personal";
  }>(
    `SELECT workspace.owner_user_id, workspace.scope, membership.role
     FROM workspaces AS workspace
     JOIN family_memberships AS membership
       ON membership.family_id = workspace.family_id AND membership.user_id = $2
     WHERE workspace.id = $1 AND workspace.family_id = $3
       AND workspace.scope IN ('personal', 'family')
     FOR SHARE OF workspace, membership`,
    [auth.workspaceId, auth.userId, auth.familyId],
  );
  const workspace = result.rows[0];
  const personal = workspace?.scope === "personal" && workspace.owner_user_id === auth.userId;
  const family = workspace?.scope === "family";
  if (!workspace || workspace.scope !== auth.scope || (!personal && !family)) {
    throw new AppError(
      "AGENT_GOOGLE_WORKSPACE_ACCESS_DENIED",
      "У вас нет доступа к этому профилю Google Workspace",
    );
  }
  if (management && family && workspace.role !== "owner") {
    throw new AppError(
      "AGENT_OWNER_REQUIRED",
      "Подключать и отключать общий Google Workspace может только владелец семьи",
    );
  }
}
