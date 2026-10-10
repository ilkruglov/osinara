/**
 * Who and where an interactive Telegram turn is, read from the verified session auth.
 *
 * Export:
 * - `turnIdentity`: family, chat kind, group, user, chat id and the triggering journal entry of a
 *   root Telegram turn; null for subagents, the silent memory review and non-Telegram sessions.
 *
 * Shared by the improvement backlog and the turn evaluation so both name the same chat the same way.
 */
import type { SessionAuth } from "eve/context";

import { isMemoryReviewSession } from "../memory-review/memory-review-session.js";

export type TurnChatKind = "external" | "family" | "private";

export interface TurnIdentity {
  chatKind: TurnChatKind;
  familyId: string;
  /** Registered Telegram group of a group chat; null in a private chat. */
  groupId: string | null;
  telegramChatId: string | null;
  /** Journal entry of the message that started the turn, when the turn has one. */
  triggeringEntryId: string | null;
  userId: string | null;
}

export interface TurnIdentityContext {
  /** Absent in channel event contexts, which are never a subagent's. */
  channel?: { kind?: string };
  session: { auth: SessionAuth; id: string };
}

export function turnIdentity(ctx: TurnIdentityContext): TurnIdentity | null {
  if (ctx.channel?.kind === "subagent" || isMemoryReviewSession(ctx)) return null;
  const attributes = ctx.session.auth.current?.attributes;
  if (ctx.session.auth.current?.authenticator !== "telegram" || !attributes) return null;
  const familyId = attributes.familyId;
  if (typeof familyId !== "string") return null;
  const chatKind = attributes.telegramChatType === "private"
    ? "private"
    : attributes.groupType === "family_private" ? "family" : "external";
  const principalId = ctx.session.auth.current?.principalId;
  const userId = ctx.session.auth.current?.principalType === "user" && typeof principalId === "string"
    ? principalId
    : null;
  const text = (value: unknown) => typeof value === "string" && value.length > 0 ? value : null;
  return {
    chatKind,
    familyId,
    groupId: text(attributes.groupId),
    telegramChatId: text(attributes.telegramChatId),
    triggeringEntryId: text(attributes.telegramTimelineEntryId),
    userId,
  };
}
