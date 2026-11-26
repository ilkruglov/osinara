/**
 * Telegram inbound authorization boundary.
 *
 * Exports:
 * - `createTelegramMessageHandler`: builds an independently testable authorization handler.
 * - `handleTelegramMessage`: production handler using PostgreSQL repositories.
 *
 * Key constructs:
 * - Group reply routing accepts bot or sender-less references only for exact known routes.
 * - Timeline-proven agent replies can start a fresh message turn after application session rotation.
 * - One server-clock snapshot anchors all time-sensitive work and model context in an accepted turn.
 * - Registered groups project the verified dynamic skill policy into turn auth.
 * - Production side-effect adapters are assembled in `telegram-on-message-repositories.ts`.
 * - An ephemeral `/whisper` takes its own path (`whisper/telegram-whisper-turn.ts`) before the
 *   group journal: nothing ephemeral is ever journaled.
 */
import type {
  TelegramContext,
  TelegramInboundResult,
  TelegramMessage,
} from "eve/channels/telegram";

import { bindTelegramConversationTimeline } from "./telegram-conversation-timeline.js";
import { evaluateConversationAccess } from "./family-access.js";
import { parseInvitationStartCommand } from "./invitation-code.js";
import { handleTelegramEnrollmentBoundary } from "./telegram-enrollment-boundary.js";
import {
  classifyTelegramInboundMedia,
  isMessageAddressedToBot,
  isTelegramSlashCommand,
  telegramMessageText,
} from "./telegram-message-policy.js";
import { parseExternalGroupToolAllowlist } from "./tool-policy/group-tool-catalog.js";
import { telegramForumTopicId } from "./telegram-group-message-storage.js";
import { deliverPendingMemoryThreadNotice } from "./telegram-memory-thread-notice.js";
import { verifiedTelegramProfileSignals } from "./telegram-profile-subjects.js";
import { sameTelegramGroupPolicy } from "./telegram-group-policy-snapshot.js";
import { persistPrivateAttachments, prepareTelegramTurn } from "./telegram-turn-preparation.js";
import { telegramReplyContinuationTokens } from "./telegram-reply-routing.js";
import { authorizeTelegramReply } from "./telegram-reply-authorization.js";
import { telegramReplyAttachmentTarget } from "./telegram-reply-attachment.js";
import {
  productionTelegramMessageRepositories,
  type TelegramMessageRepositories,
} from "./telegram-on-message-repositories.js";
import { telegramInboundActor } from "./telegram-inbound-actor.js";
import { readTelegramSeriesMarker, wasAddressedInSeries } from "./telegram-message-series.js";
import { prepareTelegramWhisperTurn } from "./whisper/telegram-whisper-turn.js";
import {
  isTelegramEphemeralMessage,
  readTelegramWhisperMarker,
} from "./whisper/telegram-whisper.js";

export function createTelegramMessageHandler(repositories: TelegramMessageRepositories) {
  return async function handleMessage(
    ctx: TelegramContext,
    message: TelegramMessage,
  ): Promise<TelegramInboundResult> {
    const actor = telegramInboundActor(message);
    if (!actor || message.chat.type === "channel") return null;

    // Resolve invocation from verified channel data before any identity or model work.
    const botUsername = ctx.telegram.botUsername;
    if (!botUsername) {
      throw new Error("AGENT_TELEGRAM_CONFIG_MISSING: Не задано имя Telegram-бота");
    }
    // An ephemeral message (`message_id` 0) is seen by its author and the bot only: it never enters
    // the group journal. A whisper the ingress accepted has its own turn; nothing else proceeds.
    if (isTelegramEphemeralMessage(message.raw)) {
      const whisperMarker = readTelegramWhisperMarker(message.raw);
      return whisperMarker === null
        ? null
        : await prepareTelegramWhisperTurn({
            actor,
            botUsername,
            dependencies: repositories,
            marker: whisperMarker,
            message,
          });
    }
    const dispatchText = telegramMessageText(message);
    const routingText = Object.hasOwn(message.raw, "voice") ? message.caption : dispatchText;
    let addressed = isMessageAddressedToBot({ ...message, text: routingText }, botUsername);
    // A series marker comes from the durable ingress, never from Telegram: earlier messages of a
    // run are journaled without a turn, and the last one answers the whole run.
    const series = readTelegramSeriesMarker(message.raw);
    const seriesContext = series?.role === "context";
    if (series?.role === "current" && series.addressed) addressed = true;
    // A member its series returned to the queue alone keeps the address of the caption that called Mia.
    if (wasAddressedInSeries(message.raw)) addressed = true;
    const unsupportedGroupSlashCommand =
      message.chat.type !== "private" && isTelegramSlashCommand(routingText);
    let verifiedReplyRoute: string | undefined;
    let exactReplyRoute: string | undefined;
    let hasResumableReplyRoute = false;

    const invitationCode = Object.hasOwn(message.raw, "voice")
      ? null
      : parseInvitationStartCommand(message.text, botUsername);
    if (invitationCode && message.chat.type !== "private") {
      // Leaked deep links in any group are dropped silently before identity or session work.
      return null;
    }

    // Registered group policy is required before passive messages may be persisted.
    const groupChatType =
      message.chat.type === "group" || message.chat.type === "supergroup"
        ? message.chat.type
        : null;
    const group =
      groupChatType === null
        ? null
        : await repositories.telegram.findGroup(message.chat.id, groupChatType);
    if (
      actor.kind === "telegram_channel" &&
      (group?.type !== "external" || group.messageMode === "owner_only")
    )
      return null;
    const forumTopicId = group ? telegramForumTopicId(message) : null;
    const mediaKind = classifyTelegramInboundMedia(message);
    const externalAllowlist =
      group?.type !== "family_private"
        ? parseExternalGroupToolAllowlist(group?.toolAllowlist)
        : null;
    const externalImageAllowed =
      (mediaKind === "native_photo" || mediaKind === "image_document_candidate") &&
      externalAllowlist?.has("inspect_workspace_image") === true;
    const externalTextAttachmentAllowed =
      mediaKind === "text_document_candidate" &&
      externalAllowlist?.has("import_telegram_attachment") === true;
    let journalDuplicate = false;
    let inboundTimeline: Awaited<
      ReturnType<TelegramMessageRepositories["journal"]["record"]>
    > | null = null;
    const hasLazyGroupAttachment =
      group !== null &&
      message.attachments.length > 0 &&
      (group.type === "family_private" || externalImageAllowed || externalTextAttachmentAllowed);
    if (message.chat.type !== "private") {
      if (!group) return null;
      // External media is fail-closed except for the exact capability admitted by its classifier.
      if (
        group.type !== "family_private" &&
        mediaKind !== "none" &&
        !externalImageAllowed &&
        !externalTextAttachmentAllowed
      ) {
        return null;
      }
      // Every registered group shares one timeline independently of whether this message starts a turn.
      inboundTimeline = await repositories.journal.record(group.groupId, message, actor);
      if (inboundTimeline.status === "duplicate") {
        journalDuplicate = true;
        if (!hasLazyGroupAttachment) return null;
      }
      if (unsupportedGroupSlashCommand) {
        if (
          inboundTimeline.status === "inserted" &&
          (actor.kind === "telegram_user" || actor.kind === "telegram_bot")
        ) {
          await repositories.memoryReview.observePassiveMessage({
            groupId: group.groupId,
            timelineEntryId: inboundTimeline.entryId,
          });
        }
        return null;
      }
      if (inboundTimeline.replyToAgent) addressed = true;
      const routeEligibleReply =
        message.replyToMessage &&
        (inboundTimeline.replyToAgent || message.replyToMessage.from?.isBot !== false);
      if (routeEligibleReply) {
        // Telegram may omit the sender entirely from a compact Rich Message reply reference.
        // A route proves a bot/sender-less anchor, but never overrides an explicit user sender.
        const candidateRoutes = telegramReplyContinuationTokens(message);
        exactReplyRoute = candidateRoutes[0];
        for (const candidateRoute of candidateRoutes) {
          if (await repositories.session.hasRoute(candidateRoute)) {
            addressed = true;
            verifiedReplyRoute = candidateRoute;
            hasResumableReplyRoute = true;
            break;
          }
        }
      }
      if (inboundTimeline.replyToAgent && exactReplyRoute === undefined) {
        throw new Error(
          "AGENT_TELEGRAM_TIMELINE_REPLY_ROUTE_MISSING: Для подтверждённого ответа в истории отсутствует Telegram-маршрут",
        );
      }
      // Authorized family attachment references are retained without waking the model.
      if ((!addressed || seriesContext) && !hasLazyGroupAttachment) {
        if (inboundTimeline.status === "inserted") {
          if (actor.kind === "telegram_user" || actor.kind === "telegram_bot") {
            await repositories.memoryReview.observePassiveMessage({
              groupId: group.groupId,
              timelineEntryId: inboundTimeline.entryId,
            });
          }
        }
        return null;
      }
    } else if (!addressed) {
      return null;
    }

    const identity =
      actor.kind === "telegram_user" ? await repositories.telegram.findIdentity(actor.id) : null;

    // Group policy and identity are separate DB records. Re-reading the group establishes a
    // fail-closed authorization boundary if owner-only mode, type, or capabilities changed while
    // the incoming message was journaled and participant identity was resolved.
    if (
      group &&
      groupChatType !== null &&
      !sameTelegramGroupPolicy(
        group,
        await repositories.telegram.findGroup(message.chat.id, groupChatType),
      )
    ) {
      return null;
    }

    // Owner-only external groups retain everyone's timeline but dispatch solely for the current
    // persisted Osinara owner; Telegram administrator status never grants application authority.
    if (
      group?.messageMode === "owner_only" &&
      (identity?.familyId !== group.familyId || identity.role !== "owner")
    )
      return null;

    if (
      actor.kind === "telegram_user" &&
      (await handleTelegramEnrollmentBoundary({
        ctx,
        identity,
        invitationCode,
        message,
        repositories,
      }))
    )
      return null;

    // Auth attributes carry only values derived from the verified webhook and persisted policy.
    const decision = evaluateConversationAccess({
      actorKind: actor.kind,
      chat: { id: message.chat.id, type: message.chat.type },
      identity,
      registeredGroup: group,
    });
    if (!decision.allowed) {
      // Group denials remain silent; private users receive a safe enrollment hint.
      if (message.chat.type === "private") await ctx.telegram.sendMessage(decision.error.message);
      return null;
    }

    const access = decision.access;
    const turnStartedAt = new Date();

    // Authorization precedes private persistence. Group persistence already occurred before trigger
    // evaluation so passive registered-group messages remain complete.
    const timelineBinding = await bindTelegramConversationTimeline({
      conversations: repositories.conversations,
      existingGroupTimeline: inboundTimeline,
      familyId: access.familyId,
      groupId: group?.groupId ?? null,
      message,
      timeline: repositories.timeline,
    });
    const conversation = timelineBinding.conversation;
    inboundTimeline = timelineBinding.inboundTimeline;
    if (message.chat.type === "private" && inboundTimeline.status === "duplicate") return null;
    // Group media stays remote until a mode-authorized tool consumes this safe opaque reference.
    const currentAttachment =
      hasLazyGroupAttachment && group
        ? await repositories.attachmentReferences.record(group.groupId, message)
        : null;
    const replyAttachmentTarget =
      group && inboundTimeline ? telegramReplyAttachmentTarget(message, group) : null;
    const replyMediaKind = replyAttachmentTarget
      ? classifyTelegramInboundMedia(replyAttachmentTarget)
      : "none";
    const externalReplyAllowed =
      ((replyMediaKind === "native_photo" || replyMediaKind === "image_document_candidate") &&
        externalAllowlist?.has("inspect_workspace_image") === true) ||
      (replyMediaKind === "text_document_candidate" &&
        externalAllowlist?.has("import_telegram_attachment") === true);
    const replyAttachment =
      replyAttachmentTarget &&
      group &&
      inboundTimeline &&
      (group.type === "family_private" || externalReplyAllowed)
        ? await repositories.attachmentReferences.captureReplyTarget(
            group.groupId,
            inboundTimeline.entryId,
            replyAttachmentTarget,
          )
        : null;
    const lazyAttachment = currentAttachment ?? replyAttachment;
    // An earlier message of a series starts no turn, but its file must be there for the last one's.
    if (seriesContext) await persistPrivateAttachments({ decision, group, message, repositories });
    if (!addressed || journalDuplicate || seriesContext) {
      if (
        !addressed &&
        !journalDuplicate &&
        group &&
        inboundTimeline &&
        (actor.kind === "telegram_user" || actor.kind === "telegram_bot")
      ) {
        await repositories.memoryReview.observePassiveMessage({
          groupId: group.groupId,
          timelineEntryId: inboundTimeline.entryId,
        });
      }
      return null;
    }

    // The accepted verified message reactivates exactly its participant identity before profile
    // selection. This does not enumerate or inject every participant in the conversation.
    await repositories.conversations.syncTimelineParticipants(conversation.id, [
      inboundTimeline.entryId,
    ]);
    // A persisted agent timeline anchor is trusted even when Telegram omits compact sender metadata.
    const replyAuthorization = await authorizeTelegramReply({
      actor,
      botUsername,
      exactReplyRoute,
      hasResumableReplyRoute,
      hitl: repositories.hitl,
      message,
      replyToAgent: inboundTimeline?.replyToAgent === true,
      sendMessage: (text) => ctx.telegram.sendMessage(text),
      verifiedReplyRoute,
    });
    if (!replyAuthorization.accepted) return null;

    // Context snapshots and one-time notices are consumed only after reply/HITL authorization has
    // proved that this accepted message will continue into an agent turn.
    const profileSignals =
      actor.kind === "telegram_user"
        ? verifiedTelegramProfileSignals(message)
        : { explicitMentionTelegramUserIds: [], replyTelegramUserId: null };
    // Thread lifecycle is silent in shared chats; only a verified private turn may consume notices.
    if (message.chat.type === "private") {
      if (actor.kind !== "telegram_user") {
        throw new Error("AGENT_TELEGRAM_ACTOR_INVALID: Личный чат требует Telegram user identity");
      }
      await deliverPendingMemoryThreadNotice(
        {
          familyId: access.familyId,
          groupId: access.groupId,
          role: access.role,
          scopes: access.memoryScopes,
          telegramActorId: actor.id,
          telegramActorKind: actor.kind,
          telegramUserId: actor.id,
          userId: access.userId,
        },
        conversation.id,
        repositories.threadNotices,
        (text) => ctx.telegram.sendMessage(text),
      );
    }
    if (group) {
      const policyNotice = await repositories.profilePolicies.claimPendingGroupNotice(
        group.groupId,
      );
      if (policyNotice) {
        await ctx.telegram.sendMessage(
          `AGENT_PROFILE_PROJECTION_POLICY_NOTICE: ${policyNotice.text}`,
        );
        await repositories.profilePolicies.markGroupNoticePresented({
          deliveryToken: policyNotice.deliveryToken,
          noticeRef: policyNotice.noticeRef,
        });
      }
    }

    return await prepareTelegramTurn({
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
      reply: replyAuthorization,
      repositories,
      series,
      turnStartedAt,
    });
  };
}

export const handleTelegramMessage = createTelegramMessageHandler(
  productionTelegramMessageRepositories,
);
