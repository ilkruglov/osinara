/**
 * Checks a family repository repeats inside its own transaction.
 *
 * Exports:
 * - `requireCurrentMembership`: the caller's live role in the family, or `AGENT_ACCESS_DENIED`.
 * - `requireTimezone`: the IANA name as PostgreSQL knows it, or `AGENT_TIMEZONE_INVALID`.
 * - `personalChatUserId`, `isLivePersonalMember`: a family member writing in their own private chat,
 *   by the turn's identity and then by the live membership; the shopping list and the health
 *   journal both keep a person's own data behind this pair.
 *
 * Key construct:
 * - Reminders and agent schedules each carried byte-identical copies under different names, and
 *   external group schedules a third inline. Membership is re-read in the transaction because a
 *   person removed from the family between the turn start and the write must not change anything.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import type { MemoryAuthorization } from "./memory-context.js";

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
export async function lockCurrentOwner(
  client: PoolClient,
  familyId: string,
  userId: string,
): Promise<boolean> {
  const owner = await client.query(
    `SELECT 1 FROM family_memberships
      WHERE family_id = $1 AND user_id = $2 AND role = 'owner'
      FOR SHARE`,
    [familyId, userId],
  );
  return owner.rowCount === 1;
}

/** `lockCurrentOwner` that refuses with `AGENT_OWNER_REQUIRED`. */
export async function requireLockedOwner(
  client: PoolClient,
  familyId: string,
  userId: string,
): Promise<void> {
  if (!(await lockCurrentOwner(client, familyId, userId))) {
    throw new AppError("AGENT_OWNER_REQUIRED", "Это действие доступно только владельцу");
  }
}

/**
 * The person's user id when the turn is theirs in their own private chat: a Telegram user acting as
 * themselves, not an external role, no group. Null otherwise; the caller names its own refusal.
 */
export function personalChatUserId(auth: MemoryAuthorization): string | null {
  if (
    auth.telegramActorKind !== "telegram_user" ||
    !auth.telegramUserId ||
    !auth.userId ||
    auth.telegramActorId !== auth.telegramUserId ||
    auth.role === "external" ||
    auth.groupId !== null
  )
    return null;
  return auth.userId;
}

/** Whether that person is still a member of the family under the same Telegram account. */
export async function isLivePersonalMember(
  client: PoolClient,
  auth: MemoryAuthorization,
  userId: string,
): Promise<boolean> {
  const member = await client.query(
    `SELECT 1 FROM family_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.family_id = $1 AND m.user_id = $2 AND u.telegram_user_id = $3`,
    [auth.familyId, userId, auth.telegramUserId],
  );
  return member.rowCount === 1;
}
