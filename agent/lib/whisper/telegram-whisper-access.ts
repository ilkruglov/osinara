/**
 * Who may whisper to Mia in a group.
 *
 * Export:
 * - `authorizeTelegramWhisper`: the registered group and the access a whisper's author has there,
 *   or null when the whisper must stay unanswered.
 *
 * Key construct:
 * - The same rules as for a message in that group: a family group admits members of its family,
 *   an external group admits anyone unless it is in owner-only mode, which admits only the current
 *   owner of the group's family. The webhook gate and the turn both call it; the turn re-reads the
 *   policy, so a change between the two closes the whisper.
 */
import type { TelegramMessage } from "eve/channels/telegram";

import {
  evaluateConversationAccess,
  type ConversationAccessDecision,
  type FamilyIdentity,
  type RegisteredGroup,
} from "../family-access.js";
import { sameTelegramGroupPolicy } from "../telegram-group-policy-snapshot.js";
import type { TelegramRepository } from "../telegram-repository.js";

export interface AuthorizedTelegramWhisper {
  readonly decision: Extract<ConversationAccessDecision, { allowed: true }>;
  readonly group: RegisteredGroup;
  readonly identity: FamilyIdentity | null;
}

export async function authorizeTelegramWhisper(
  telegram: Pick<TelegramRepository, "findGroup" | "findIdentity">,
  message: Pick<TelegramMessage, "chat">,
  telegramUserId: string,
): Promise<AuthorizedTelegramWhisper | null> {
  const chatType = message.chat.type;
  if (chatType !== "group" && chatType !== "supergroup") return null;
  const group = await telegram.findGroup(message.chat.id, chatType);
  if (!group) return null;
  const identity = await telegram.findIdentity(telegramUserId);
  // Group policy and identity are separate records: a policy changed while the author was looked
  // up (owner-only switched on, the type changed) closes the whisper, as for an ordinary message.
  if (!sameTelegramGroupPolicy(group, await telegram.findGroup(message.chat.id, chatType)))
    return null;
  if (
    group.messageMode === "owner_only" &&
    (identity?.familyId !== group.familyId || identity.role !== "owner")
  )
    return null;
  const decision = evaluateConversationAccess({
    actorKind: "telegram_user",
    chat: { id: message.chat.id, type: chatType },
    identity,
    registeredGroup: group,
  });
  return decision.allowed ? { decision, group, identity } : null;
}
