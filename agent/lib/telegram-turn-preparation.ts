/**
 * The turn of an accepted, authorized Telegram message: its session, context, memory and the
 * result Eve sends to the model.
 *
 * Exports:
 * - `prepareTelegramTurn`: everything after authorization, from storing a private file to the
 *   result; split from `telegram-on-message.ts` (26 November 2026) to keep both under the module
 *   size limit, with no change of behaviour.
 * - `persistPrivateAttachments`: a private message's files into the workspace inbox, also for an
 *   earlier message of a series, which starts no turn.
 *
 * Key constructs:
 * - One server-clock snapshot (`turnStartedAt`) anchors session rotation, pending deliveries and
 *   model-visible time.
 * - The files of earlier series messages come from what the session has not seen yet
 *   (`telegram-series-attachments.ts`).
 */
import type { TelegramInboundResult, TelegramMessage } from "eve/channels/telegram";

import type { StoredTelegramAttachment } from "./attachments/telegram-workspace-attachments.js";
import { AppError } from "./app-error.js";
import type { ApplicationConversation } from "./conversation-repository.js";
import type { ConversationAccessDecision, RegisteredGroup } from "./family-access.js";
import { CONVERSATION_TIMELINE_SELECTION_MAX_ENTRIES } from "./memory-config.js";
import { prepareTelegramMemoryReviewTurn } from "./memory-review/telegram-memory-review-turn.js";
import { logProcessMemory } from "./process-memory.js";
import { groupCanonicalContinuationToken } from "./sessions/group-canonical-token.js";
import type { bindTelegramConversationTimeline } from "./telegram-conversation-timeline.js";
import type { TelegramAttachmentReference } from "./telegram-group-journal-context.js";
import { telegramSenderTag, type TelegramInboundActor } from "./telegram-inbound-actor.js";
import { telegramForwardMarker, withForwardMarker } from "./telegram-message-policy.js";
import type { TelegramSeriesMarker } from "./telegram-message-series.js";
import {
  telegramAttachmentScope,
  telegramProactiveDeliveryAuthorization,
  telegramProfileName,
  telegramSessionScope,
  telegramWorkspaceAuthorization,
} from "./telegram-on-message-context.js";
import type { TelegramMessageRepositories } from "./telegram-on-message-repositories.js";
import {
  formatPendingMessagesContext,
  readTelegramPendingMarker,
} from "./telegram-pending-messages.js";
import type { verifiedTelegramProfileSignals } from "./telegram-profile-subjects.js";
import type { TelegramReplyAuthorizationResult } from "./telegram-reply-authorization.js";
import { telegramBaseContinuationToken } from "./telegram-reply-routing.js";
import { telegramReplyTargetProjection } from "./telegram-reply-target-snapshot.js";
import { unseenAttachmentReferences, unseenFileMessageIds } from "./telegram-series-attachments.js";
import { buildTelegramTurnResult } from "./telegram-turn-result.js";
import { readTelegramUpdateMarker } from "./telegram-update-marker.js";
import type { parseExternalGroupToolAllowlist } from "./tool-policy/group-tool-catalog.js";
import { createTurnInterjectionMarker } from "./turn-interjection/turn-interjection-block.js";
import { logTurnTiming } from "./turn-timing.js";

type AllowedDecision = Extract<ConversationAccessDecision, { allowed: true }>;

interface TelegramTurnPreparationInput {
  actor: TelegramInboundActor;
  conversation: ApplicationConversation;
  decision: AllowedDecision;
  dispatchText: string;
  exactReplyRoute: string | undefined;
  externalAllowlist: ReturnType<typeof parseExternalGroupToolAllowlist>;
  forumTopicId: string | null;
  group: RegisteredGroup | null;
  inboundTimeline: Awaited<ReturnType<typeof bindTelegramConversationTimeline>>["inboundTimeline"];
  lazyAttachment: TelegramAttachmentReference | null;
  message: TelegramMessage;
  profileSignals: ReturnType<typeof verifiedTelegramProfileSignals>;
  reply: TelegramReplyAuthorizationResult;
  repositories: TelegramMessageRepositories;
  series: TelegramSeriesMarker | null;
  turnStartedAt: Date;
}

/**
 * A private message's files go to the workspace inbox; a group's stay remote references. A failure
 * is the ingress's to tell the person (`sendTelegramFailureNotice`): a notice here made two replies
 * to one failed file.
 */
export async function persistPrivateAttachments(input: {
  decision: AllowedDecision;
  group: RegisteredGroup | null;
  message: TelegramMessage;
  repositories: Pick<TelegramMessageRepositories, "attachments">;
}): Promise<StoredTelegramAttachment[]> {
  const { decision, group, message } = input;
  if (message.attachments.length === 0 || message.chat.type !== "private") return [];
  return await input.repositories.attachments.persist({
    attachments: message.attachments,
    auth: telegramWorkspaceAuthorization(decision, group, message),
    chatId: message.chat.id,
    messageId: message.messageId,
    scope: telegramAttachmentScope(decision),
  });
}

export async function prepareTelegramTurn(
  input: TelegramTurnPreparationInput,
): Promise<TelegramInboundResult> {
  const {
    actor,
    conversation,
    decision,
    dispatchText,
    exactReplyRoute,
    externalAllowlist,
    forumTopicId,
    group,
    inboundTimeline,
    lazyAttachment,
    message,
    profileSignals,
    repositories,
    series,
    turnStartedAt,
  } = input;
  const { replyHandling, resumesPendingTask, verifiedReplyRoute } = input.reply;
  const access = decision.access;
  const storedAttachments = await persistPrivateAttachments(input);
  // One instant anchors session rotation, pending-delivery visibility, and model-visible time.
  const resolvedSessionScope = telegramSessionScope(decision);
  const verifiedForumTopicId = forumTopicId === null ? null : Number(forumTopicId);
  const baseContinuationToken = group
    ? resumesPendingTask
      ? telegramBaseContinuationToken(message, verifiedReplyRoute ?? exactReplyRoute)
      : groupCanonicalContinuationToken(group.groupId, verifiedForumTopicId)
    : telegramBaseContinuationToken(message, verifiedReplyRoute);
  const appSession = await repositories.session.prepareTurn({
    baseContinuationToken,
    familyId: access.familyId,
    kind: resumesPendingTask ? "task" : "canonical",
    now: turnStartedAt,
    telegramForumTopicId: verifiedForumTopicId,
    ...resolvedSessionScope,
  });
  const deliveryAuthorization = telegramProactiveDeliveryAuthorization(decision, message);
  const pendingDeliveries = deliveryAuthorization
    ? await repositories.proactiveDeliveries.listPendingContext({
        ...deliveryAuthorization,
        applicationSessionId: appSession.id,
        now: turnStartedAt,
      })
    : null;
  // One verification of the reply target serves both projections: its full text is needed only
  // when the journal has no target (a journaled one joins the timeline through its reply chain),
  // the selected fragment whenever there is one.
  const replyTarget = telegramReplyTargetProjection(message);
  const replyTargetSnapshot = inboundTimeline.replyTargetUnavailable ? replyTarget.snapshot : null;
  const replyQuotedText = replyTarget.quotedText;
  // Only this author's own journaled messages can be named; a foreign id resolves to nothing.
  const seriesSequenceIds =
    series?.role === "current" && series.telegramMessageIds.length > 0
      ? await repositories.journal.findSeriesSequences({
          actorId: actor.actorId,
          conversationId: conversation.id,
          telegramMessageIds: series.telegramMessageIds,
        })
      : [];
  // Local civil time is a convenience for natural answers and the clock of the timeline stamps;
  // a lookup failure must not cost the turn. The sender's own timezone wins, else the owner's.
  let timezone: string | null = null;
  try {
    timezone = await repositories.currentTime.findTurnTimezone(
      access.userId ?? null,
      access.familyId,
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        code: "AGENT_CURRENT_TIME_TIMEZONE_LOOKUP_FAILED",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  // The thread of the session the turn limit just retired: summarized now, shown once by the
  // context preparer below. One turn per fifty waits for it; a miss is a cold start, as before.
  if (appSession.handoff) {
    await repositories.sessionHandoff.prepare({
      applicationSessionId: appSession.id,
      beforeSequence: inboundTimeline.sequenceId,
      conversationId: group ? null : conversation.id,
      groupId: group?.groupId ?? null,
      messageThreadId: forumTopicId,
      retiredSessionStartedAt: appSession.handoff.retiredSessionStartedAt,
      timezone,
    });
  }
  const senderTag = telegramSenderTag(message);
  const preparedGroupTurnContext = await repositories.groupContext.prepare({
    applicationSessionId: appSession.id,
    attachmentReferenceAccess:
      group?.type === "family_private"
        ? "all"
        : group?.type === "external"
          ? {
              images: externalAllowlist?.has("inspect_workspace_image") === true,
              readableText: externalAllowlist?.has("import_telegram_attachment") === true,
            }
          : "none",
    currentEntryId: inboundTimeline.entryId,
    currentSenderDisplayName: actor.displayName ?? telegramProfileName(message),
    ...(senderTag === null ? {} : { currentSenderTag: senderTag }),
    currentSenderUsername: actor.username,
    currentSequence: inboundTimeline.sequenceId,
    ...(group ? {} : { conversationId: conversation.id }),
    groupId: group?.groupId ?? null,
    // The model reads a forward as someone else's words; routing above read the plain text.
    messageText: withForwardMarker(telegramForwardMarker(message.raw), dispatchText),
    messageThreadId: forumTopicId,
    ...(replyQuotedText === null ? {} : { replyQuotedText }),
    ...(replyTargetSnapshot === null ? {} : { replyTargetSnapshot }),
    replyTargetUnavailable: inboundTimeline.replyTargetUnavailable,
    replyToSequenceId: inboundTimeline.replyToSequenceId,
    ...(seriesSequenceIds.length === 0 ? {} : { seriesSequenceIds }),
    timezone,
  });
  const groupTurnContext =
    group && actor.kind === "telegram_user"
      ? await prepareTelegramMemoryReviewTurn({
          applicationSessionId: appSession.id,
          conversationId: conversation.id,
          currentEntryId: inboundTimeline.entryId,
          groupId: group.groupId,
          preparedContext: preparedGroupTurnContext,
          repositories: {
            memoryReview: repositories.memoryReview,
            syncParticipants: (conversationId, entryIds) =>
              repositories.conversations.syncTimelineParticipants(conversationId, entryIds),
          },
        })
      : preparedGroupTurnContext;
  if (!group) {
    // The current participant was synchronized before context preparation. Remaining private
    // history can exceed the repository's bounded selection contract, so synchronize it in order.
    if (
      groupTurnContext.visibleEntryIds.length === 0 ||
      new Set(groupTurnContext.visibleEntryIds).size !== groupTurnContext.visibleEntryIds.length
    ) {
      throw new AppError(
        "AGENT_CONVERSATION_TIMELINE_SELECTION_INVALID",
        "Набор записей разговора пуст или содержит повторы",
      );
    }
    const additionalEntryIds = groupTurnContext.visibleEntryIds.filter(
      (entryId) => entryId !== inboundTimeline.entryId,
    );
    for (
      let offset = 0;
      offset < additionalEntryIds.length;
      offset += CONVERSATION_TIMELINE_SELECTION_MAX_ENTRIES
    ) {
      await repositories.conversations.syncTimelineParticipants(
        conversation.id,
        additionalEntryIds.slice(offset, offset + CONVERSATION_TIMELINE_SELECTION_MAX_ENTRIES),
      );
    }
  }
  // Memory travels with the delivery so the cacheable system prefix never changes between turns.
  const retrievedMemoryContext = await repositories.memoryContext({
    access,
    actor: { id: actor.id, kind: actor.kind },
    applicationSessionId: appSession.id,
    conversationId: conversation.id,
    explicitMentionTelegramUserIds: profileSignals.explicitMentionTelegramUserIds,
    query: dispatchText,
    replyTelegramUserId: profileSignals.replyTelegramUserId,
    replyTimelineSequence: inboundTimeline.replyToSequenceId,
    timelineEntryId: inboundTimeline.entryId,
    turnStartedAt,
  });
  // What the chat said after this message and still waits in the queue, from the durable ingress.
  const pendingBlock = formatPendingMessagesContext(readTelegramPendingMarker(message.raw));
  const memoryContext =
    pendingBlock === null ? retrievedMemoryContext : [...retrievedMemoryContext, pendingBlock];
  // A running turn of this same conversation may already have seen this message with a tool result.
  const currentUpdateId = readTelegramUpdateMarker(message.raw);
  const shownDuringTurn =
    currentUpdateId !== null
      ? await repositories.turnInterjections.findDeliveredContentKind(
          currentUpdateId,
          appSession.id,
        )
      : null;
  const earlierInSeries = series?.role === "current" ? (series.earlierUpdateIds ?? []) : [];
  const shownEarlierInSeries =
    earlierInSeries.length > 0
      ? [
          ...(
            await repositories.turnInterjections.findDeliveredContentKinds(
              earlierInSeries,
              appSession.id,
            )
          ).values(),
        ].filter((kind) => kind !== "notice").length
      : 0;
  // Messages its author sends while this turn works can reach it only in the trusted zones.
  const turnInterjectionMarker =
    currentUpdateId !== null &&
    !resumesPendingTask &&
    actor.kind === "telegram_user" &&
    (group === null || group.type === "family_private")
      ? createTurnInterjectionMarker()
      : null;
  const turnResult = buildTelegramTurnResult({
    currentUpdateId,
    shownDuringTurn,
    shownEarlierInSeries,
    turnInterjectionMarker,
    access,
    actor,
    appSession,
    conversation,
    forumTopicId,
    group,
    // A group's earlier photos of the author come as references, the current one last.
    lazyAttachments: uniqueAttachments([
      ...(group
        ? unseenAttachmentReferences(groupTurnContext.unseenTimelineEntries, actor.id)
        : []),
      ...(lazyAttachment ? [lazyAttachment] : []),
    ]),
    memoryContext,
    message,
    pendingDelivery: pendingDeliveries,
    profileSignals,
    profileReplyTimelineSequence: inboundTimeline.replyToSequenceId,
    replyHandling,
    replyQuotedText,
    // The files of earlier messages of the person since Mia's last answer come first.
    storedAttachments:
      message.chat.type === "private"
        ? [
            ...(await repositories.attachments.stored({
              auth: telegramWorkspaceAuthorization(decision, group, message),
              chatId: message.chat.id,
              messageIds: unseenFileMessageIds(
                groupTurnContext.unseenTimelineEntries,
                series?.role === "current" ? series.telegramMessageIds : [],
              ),
              scope: telegramAttachmentScope(decision),
            })),
            ...storedAttachments,
          ]
        : storedAttachments,
    timelineEntryId: inboundTimeline.entryId,
    timezone,
    turnContext: groupTurnContext,
    turnStartedAt,
  });
  // Inbound preparation ends here; `AGENT_TURN_TIMING` continues inside the Eve turn.
  const telegramDate = (message.raw as { date?: unknown }).date;
  logTurnTiming("inbound_prepared", Date.now() - turnStartedAt.getTime(), {
    sinceTelegramMs: typeof telegramDate === "number" ? Date.now() - telegramDate * 1000 : null,
  });
  logProcessMemory();
  if (!group) return turnResult;
  if (!turnResult?.auth) {
    throw new Error(
      "AGENT_TELEGRAM_TURN_AUTH_MISSING: Не удалось подготовить авторизацию Telegram-turn",
    );
  }

  return turnResult;
}

/** One reference per attachment: a reply target may also be an unseen message of the author. */
function uniqueAttachments<T extends { attachmentId: string }>(attachments: readonly T[]): T[] {
  return [
    ...new Map(attachments.map((attachment) => [attachment.attachmentId, attachment])).values(),
  ];
}
