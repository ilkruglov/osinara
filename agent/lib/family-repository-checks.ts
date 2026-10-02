/**
 * Checks a family repository repeats inside its own transaction.
 *
 * Exports:
 * - `requireCurrentMembership`: the caller's live role in the family, or `AGENT_ACCESS_DENIED`.
 * - `requireTimezone`: the IANA name as PostgreSQL knows it, or `AGENT_TIMEZONE_INVALID`.
 *
 * Key construct:
 * - Reminders and agent schedules each carried byte-identical copies under different names, and
 *   external group schedules a third inline. Membership is re-read in the transaction because a
 *   person removed from the family between the turn start and the write must not change anything.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";

export async function requireCurrentMembership(
  client: PoolClient,
  auth: { familyId: string; userId: string },
): Promise<"member" | "owner" | "recovery_owner"> {
  const membership = await client.query<{ role: "member" | "owner" | "recovery_owner" }>(
    "SELECT role FROM family_memberships WHERE family_id = $1 AND user_id = $2",
    [auth.familyId, auth.userId],
  );
  const role = membership.rows[0]?.role;
  if (!role) {
    throw new AppError("AGENT_ACCESS_DENIED", "У вас больше нет доступа к этой семье");
  }
  return role;
}

export async function requireTimezone(client: PoolClient, timezone: string): Promise<string> {
  const result = await client.query<{ name: string }>(
    "SELECT name FROM pg_timezone_names WHERE name = $1",
    [timezone],
  );
  if (!result.rows[0]) {
    throw new AppError(
      "AGENT_TIMEZONE_INVALID",
      "Не удалось распознать часовой пояс. Укажите название IANA, например Europe/Moscow",
    );
  }
  return result.rows[0].name;
}

/**
 * Whether the user is still the family owner, holding a share lock on that membership until the
 * transaction ends: a parked approval or a slow write cannot outlive a role revocation.
 */
export async function lockCurrentOwner(client: PoolClient, familyId: string, userId: string): Promise<boolean> {
  const owner = await client.query(
    `SELECT 1 FROM family_memberships
      WHERE family_id = $1 AND user_id = $2 AND role = 'owner'
      FOR SHARE`,
    [familyId, userId],
  );
  return owner.rowCount === 1;
}

/** `lockCurrentOwner` that refuses with `AGENT_OWNER_REQUIRED`. */
export async function requireLockedOwner(client: PoolClient, familyId: string, userId: string): Promise<void> {
  if (!await lockCurrentOwner(client, familyId, userId)) {
    throw new AppError("AGENT_OWNER_REQUIRED", "Это действие доступно только владельцу");
  }
}
