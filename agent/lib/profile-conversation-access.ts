/**
 * Who may read profile-like context of a conversation.
 *
 * Exports:
 * - `ProfileConversationBoundary`: the conversation's scope and owner or group.
 * - `requireConversationAccess`: locks the conversation and the viewer's membership for the
 *   transaction and refuses another family, another chat or a revoked member.
 * - `timelineReplyTelegramUserIds`: the person a reply resolved only through the journal is to.
 *
 * Shared by the profile block and the person cards, which must never be wider than it.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import type { MemoryAuthorization, MemoryScope } from "./memory-context.js";

export interface ProfileConversationBoundary {
  owner_user_id: string | null;
  scope: MemoryScope;
  telegram_group_id: string | null;
}

export async function requireConversationAccess(
  client: PoolClient,
  auth: MemoryAuthorization,
  conversationId: string,
): Promise<ProfileConversationBoundary> {
  const result = await client.query<ProfileConversationBoundary>(
    `SELECT owner_user_id, telegram_group_id, scope
     FROM application_conversations WHERE id = $1 AND family_id = $2 FOR SHARE`,
    [conversationId, auth.familyId],
  );
  const conversation = result.rows[0];
  if (!conversation || !auth.scopes.includes(conversation.scope)) {
    throw new AppError("AGENT_PROFILE_VIEW_SCOPE_DENIED", "Профиль недоступен в текущем чате");
  }
  if (
    (conversation.scope === "personal" &&
      (!auth.userId || conversation.owner_user_id !== auth.userId)) ||
    (conversation.scope !== "personal" && conversation.telegram_group_id !== auth.groupId)
  ) {
    throw new AppError("AGENT_PROFILE_VIEW_SCOPE_DENIED", "Профиль относится к другому чату");
  }
  if (conversation.scope !== "group") {
    const member = await client.query(
      "SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2 FOR SHARE",
      [auth.familyId, auth.userId],
    );
    if (!member.rowCount) {
      throw new AppError(
        "AGENT_PROFILE_VIEW_MEMBERSHIP_REVOKED",
        "Доступ к семейной проекции профиля был отозван",
      );
    }
  }
  return conversation;
}

export async function timelineReplyTelegramUserIds(
  client: PoolClient,
  conversationId: string,
  replyTimelineSequence: string,
): Promise<string[]> {
  const result = await client.query<{ telegram_user_id: string }>(
    `SELECT telegram_user_id FROM telegram_group_messages
     WHERE conversation_id = $1 AND sequence_id = $2 AND actor_kind = 'user'
       AND telegram_user_id IS NOT NULL`,
    [conversationId, replyTimelineSequence],
  );
  return result.rows.map((row) => row.telegram_user_id);
}
