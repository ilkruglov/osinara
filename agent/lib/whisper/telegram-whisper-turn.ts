/**
 * The turn of a whisper: Mia answers one person in a group, and only that person sees it.
 *
 * Export:
 * - `prepareTelegramWhisperTurn`: the inbound result for an ephemeral `/whisper` that the ingress
 *   accepted, or null (and the placeholder removed) when its author may no longer whisper there.
 *
 * Key constructs:
 * - Nothing of the whisper reaches the group: no journal entry, no memory review, no turn in the
 *   group's session. The session is of kind `whisper` (migration 142), routed per group, topic and
 *   person, on the group's sandbox thread; like every non-canonical session it ends with its turn,
 *   so each whisper starts fresh from the latest group timeline, as the ephemeral message itself.
 * - The model reads the latest group timeline as context, read-only. The auth carries the whisper
 *   attributes and none of the timeline-entry attributes: a memory write, a reaction or a chat
 *   reply would need them, and a whisper has no message in the chat to anchor any of them.
 * - Memory is read as in the group (scopes from the same access rules), without the group's skill
 *   hint, which belongs to the group's own conversation.
 */
import type { TelegramInboundResult, TelegramMessage } from "eve/channels/telegram";

import {
  TELEGRAM_GROUP_JOURNAL_CONTEXT_CHARACTERS,
  TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES,
} from "../../config.js";
import { AppError } from "../app-error.js";
import type { conversationRepository } from "../conversation-repository.js";
import { formatCurrentTimeContext } from "../current-time.js";
import type { currentTimeRepository } from "../current-time-repository.js";
import type { sessionRepository } from "../sessions/session-repository.js";
import { visibleTelegramTimelineEntry } from "../telegram-attachment-reference-access.js";
import { selectTelegramGroupJournalContext } from "../telegram-group-journal-context.js";
import type { TelegramGroupJournalRepository } from "../telegram-group-journal-repository.js";
import { telegramForumTopicId } from "../telegram-group-message-storage.js";
import { composeTelegramTurnMessage } from "../telegram-group-turn-context.js";
import type { TelegramInboundActor } from "../telegram-inbound-actor.js";
import { telegramProfileName, telegramSessionScope } from "../telegram-on-message-context.js";
import {
  telegramReplyTargetProjection,
  type TelegramReplyTargetProjection,
} from "../telegram-reply-target-snapshot.js";
import type { TelegramRepository } from "../telegram-repository.js";
import type { buildTelegramMemoryContext } from "../telegram-turn-memory-context.js";
import { escapeUntrustedContextJson } from "../untrusted-context-json.js";
import { authorizeTelegramWhisper } from "./telegram-whisper-access.js";
import type { TelegramWhisperGate } from "./telegram-whisper-gate.js";
import {
  parseTelegramWhisperCommand,
  TELEGRAM_WHISPER_ATTRIBUTE,
  TELEGRAM_WHISPER_PLACEHOLDER_ATTRIBUTE,
  TELEGRAM_WHISPER_RECEIVER_ATTRIBUTE,
  telegramWhisperContinuationToken,
  type TelegramWhisperMarker,
} from "./telegram-whisper.js";

export interface TelegramWhisperTurnDependencies {
  conversations: Pick<typeof conversationRepository, "getByGroupId">;
  currentTime: Pick<typeof currentTimeRepository, "findTurnTimezone">;
  journal: Pick<TelegramGroupJournalRepository, "listRecent">;
  session: Pick<typeof sessionRepository, "prepareTurn">;
  telegram: Pick<TelegramRepository, "findGroup" | "findIdentity">;
  whisper: Pick<TelegramWhisperGate, "close"> & { memoryContext: typeof buildTelegramMemoryContext };
}

function whisperEnvelope(input: {
  question: string;
  reply: TelegramReplyTargetProjection;
  senderDisplayName: string | null;
  senderUsername: string | null;
}): string {
  // A whisper sent as a reply asks about that message: its text and the selected fragment come
  // along, in the same fields an ordinary group turn uses for a reply.
  const current = escapeUntrustedContextJson({
    ...(input.reply.snapshot === null ? {} : { replyTargetSnapshot: input.reply.snapshot }),
    ...(input.reply.quotedText === null ? {} : { replyQuotedText: input.reply.quotedText }),
    senderDisplayName: input.senderDisplayName,
    senderUsername: input.senderUsername,
    text: input.question,
    whisper: true,
  });
  return `<current_telegram_message>\n${current}\n</current_telegram_message>`;
}

export async function prepareTelegramWhisperTurn(input: {
  actor: TelegramInboundActor;
  botUsername: string;
  dependencies: TelegramWhisperTurnDependencies;
  marker: TelegramWhisperMarker;
  message: TelegramMessage;
}): Promise<TelegramInboundResult> {
  const { actor, dependencies, marker, message } = input;
  const command = parseTelegramWhisperCommand(message, input.botUsername);
  const authorized = command && actor.kind === "telegram_user" && command.receiverUserId === marker.receiverUserId
    ? await authorizeTelegramWhisper(dependencies.telegram, message, actor.id)
    : null;
  if (!command || !authorized) {
    // The placeholder was sent under the policy of a moment ago; nothing more comes of it now.
    await dependencies.whisper.close(message.chat.id, marker);
    return null;
  }
  const { decision, group } = authorized;
  const access = decision.access;
  const conversation = await dependencies.conversations.getByGroupId(group.groupId);
  if (conversation.familyId !== access.familyId) {
    throw new AppError("AGENT_CONVERSATION_SCOPE_MISMATCH", "Разговор относится к другой семейной области");
  }
  const forumTopicId = telegramForumTopicId(message);
  const verifiedForumTopicId = forumTopicId === null ? null : Number(forumTopicId);
  const turnStartedAt = new Date();
  const appSession = await dependencies.session.prepareTurn({
    baseContinuationToken: telegramWhisperContinuationToken(group.groupId, verifiedForumTopicId, actor.id),
    familyId: access.familyId,
    // One turn per session: the group's single active canonical session stays the group's own.
    kind: "whisper",
    now: turnStartedAt,
    telegramForumTopicId: verifiedForumTopicId,
    ...telegramSessionScope(decision),
  });
  let timezone: string | null = null;
  try {
    timezone = await dependencies.currentTime.findTurnTimezone(access.userId ?? null, access.familyId);
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_CURRENT_TIME_TIMEZONE_LOOKUP_FAILED",
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  // The latest timeline of the whisper's topic, the same history a turn there starts from.
  const envelope = whisperEnvelope({
    question: command.question,
    reply: telegramReplyTargetProjection(message),
    senderDisplayName: actor.displayName ?? telegramProfileName(message),
    senderUsername: actor.username,
  });
  const timelineBudget = TELEGRAM_GROUP_JOURNAL_CONTEXT_CHARACTERS - envelope.length - 2;
  if (timelineBudget <= 0) {
    throw new AppError("AGENT_TELEGRAM_TURN_CONTEXT_TOO_LARGE", "Текущее сообщение превышает допустимый размер контекста разговора");
  }
  const recent = await dependencies.journal.listRecent({
    anchorEntryId: null,
    beforeSequence: null,
    groupId: group.groupId,
    limit: TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES,
    messageThreadId: forumTopicId,
  });
  const timeline = selectTelegramGroupJournalContext(
    recent.map((entry) => visibleTelegramTimelineEntry(entry, "none")),
    timelineBudget,
    null,
    null,
    TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES,
    timezone,
  ).context;

  const memoryContext = await dependencies.whisper.memoryContext({
    access,
    actor: { id: actor.id, kind: actor.kind },
    applicationSessionId: appSession.id,
    conversationId: conversation.id,
    explicitMentionTelegramUserIds: [],
    query: command.question,
    replyTelegramUserId: null,
    replyTimelineSequence: null,
    timelineEntryId: `whisper:${marker.placeholderMessageId}`,
    turnStartedAt,
  });

  return {
    auth: {
      attributes: {
        applicationSessionId: appSession.id,
        familyId: access.familyId,
        ...(access.groupId ? { groupId: access.groupId } : {}),
        groupType: group.type,
        memoryScopes: access.memoryScopes,
        role: access.role,
        sandboxSessionId: appSession.sandboxSessionId,
        telegramActorId: actor.id,
        telegramActorKind: actor.kind,
        telegramChatId: message.chat.id,
        telegramChatType: message.chat.type,
        telegramConversationId: conversation.id,
        ...(forumTopicId === null ? {} : { telegramForumTopicId: forumTopicId }),
        ...(message.messageThreadId === undefined ? {} : { telegramMessageThreadId: String(message.messageThreadId) }),
        telegramTurnStartedAt: turnStartedAt.toISOString(),
        telegramUserId: actor.id,
        [TELEGRAM_WHISPER_ATTRIBUTE]: "true",
        [TELEGRAM_WHISPER_PLACEHOLDER_ATTRIBUTE]: String(marker.placeholderMessageId),
        [TELEGRAM_WHISPER_RECEIVER_ATTRIBUTE]: marker.receiverUserId,
        ...(group.type !== "family_private" ? { toolAllowlist: group.toolAllowlist } : {}),
      },
      authenticator: "telegram",
      principalId: access.userId ?? actor.actorId,
      principalType: "user",
    },
    context: [
      `Verified conversation scope: ${access.memoryScopes.join(", ")}.`,
      `Verified role: ${access.role}.`,
      `Verified Telegram actor kind: ${actor.kind}.`,
      "Verified Telegram delivery: a whisper; the answer replaces a placeholder that only this person sees.",
      formatCurrentTimeContext(turnStartedAt, timezone),
      ...memoryContext,
    ],
    continuationToken: appSession.continuationToken,
    message: composeTelegramTurnMessage(timeline, envelope),
    // A whisper may answer one of Mia's messages; it is never an answer to an open question.
    replyHandling: "message",
  };
}
