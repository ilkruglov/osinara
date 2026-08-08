/**
 * Eve Telegram channel.
 *
 * Constructs:
 * - Verified webhook transport with durable PostgreSQL ingress.
 * - Application-owned family/group authorization in `onMessage`.
 * - Durable identity-bound HITL callbacks and replies.
 * - Validated attachment persistence with model-safe workspace references.
 * - Completed Rich Message or silent reaction delivery without speculative chat drafts.
 * - Verified group replies anchored to the triggering member message.
 * - Successfully delivered final group output persisted as one logical timeline entry.
 */
import { telegramChannel } from "eve/channels/telegram";

import { handleTelegramDurableIngress } from "../lib/telegram-durable-ingress.js";
import { formatTelegramTurnFailure } from "../lib/telegram-interface.js";
import { TELEGRAM_EVE_UPLOAD_POLICY } from "../lib/telegram-message-policy.js";
import { handleTelegramMessage } from "../lib/telegram-on-message.js";
import { completedTelegramOutput } from "../lib/telegram-progress.js";
import { deliverTelegramFinalOutput } from "../lib/telegram-final-delivery.js";
import { telegramFinalDeliveryRepository } from "../lib/telegram-final-delivery-repository.js";
import { postTelegramRichMessageChunk } from "../lib/telegram-rich-messages.js";
import {
  applicationSessionId,
  registerTelegramDeliveredMessageRoutes,
} from "../lib/sessions/session-context.js";
import { sessionRepository } from "../lib/sessions/session-repository.js";
import { groupTimelineCursorRepository } from "../lib/sessions/group-timeline-cursor-repository.js";
import { authorizeTelegramHitlCallback } from "../lib/telegram-hitl/callback-authorization.js";
import { handleTelegramInputRequested } from "../lib/telegram-hitl/input-request.js";
import { telegramHitlApprovalRepository } from "../lib/telegram-hitl/approval-repository.js";
import { handleTelegramSessionFailure } from "../lib/telegram-session-failure.js";
import { telegramTurnReplyParameters } from "../lib/telegram-reply.js";
import { agentScheduleDispatchRepository } from "../lib/agent-schedules/agent-schedule-dispatch-repository.js";
import {
  isScheduledSession,
  scheduledDeliveryMetadata,
} from "../lib/agent-schedules/scheduled-session.js";
import { proactiveDeliveryRepository } from "../lib/proactive-deliveries/proactive-delivery-repository.js";
import { telegramGroupJournalRepository } from "../lib/telegram-group-journal-repository.js";
import { postTelegramMessageWithoutContinuationChange } from "../lib/telegram-stable-delivery.js";
import { AppError } from "../lib/app-error.js";
import { conversationTimelineRepository } from "../lib/conversation-timeline-repository.js";
import { createTurnExtractionBatch } from "../lib/memory-extraction-batch-coordinator.js";
import { memoryApprovalNoticeRepository } from "../lib/memory-approval-notice-repository.js";
import { setTelegramMessageReaction } from "../lib/telegram-message-reaction.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export default telegramChannel({
  botUsername: process.env.TELEGRAM_BOT_USERNAME as string,
  credentials: {
    webhookSecretToken: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN as string,
  },
  drainRoute: "/eve/v1/telegram-drain",
  events: {
    "input.requested": handleTelegramInputRequested,
    async "message.completed"(data, channel, ctx) {
      // Model-authored pre-tool text is a user-visible progress update, not technical tool noise.
      if (isScheduledSession(ctx) && data.finishReason !== "stop") return;
      const output = completedTelegramOutput(data);
      if (!output) return;
      const sessionId = applicationSessionId(ctx);
      if (!await sessionRepository.isCurrentEveSession(sessionId, ctx.session.id)) return;
      const currentAttributes = ctx.session.auth.current?.attributes;
      if (output.kind === "reaction") {
        const telegramMessageId = currentAttributes?.telegramMessageId;
        if (isScheduledSession(ctx) || typeof telegramMessageId !== "string") {
          throw new AppError(
            "AGENT_TELEGRAM_REACTION_TARGET_MISSING",
            "Не удалось определить сообщение для реакции. Отправьте обращение ещё раз",
          );
        }
        await setTelegramMessageReaction(channel.telegram, telegramMessageId, output.emoji);
        return;
      }
      const message = output.message;
      const replyParameters = isScheduledSession(ctx)
        ? undefined
        : telegramTurnReplyParameters(channel.state, ctx);
      const sentMessages = await deliverTelegramFinalOutput({
        applicationSessionId: sessionId,
        deliveryIdentity: {
          chatId: channel.telegram.chatId,
          messageThreadId: channel.telegram.messageThreadId ?? null,
          replyParameters: replyParameters ?? null,
        },
        eveTurnId: ctx.session.turn.id,
        markdown: message,
        sendChunk: (chunk, ordinal) => postTelegramRichMessageChunk(
          chunk,
          channel.telegram,
          channel.state,
          ordinal === 0 ? replyParameters : undefined,
        ),
      });
      const deliveredAt = new Date();
      const scheduledDelivery = scheduledDeliveryMetadata(ctx);
      const groupId = scheduledDelivery?.groupId ??
        (typeof currentAttributes?.groupId === "string" ? currentAttributes.groupId : null);
      if (scheduledDelivery) {
        const firstMessage = sentMessages[0];
        if (!firstMessage) {
          throw new Error(
            "AGENT_SCHEDULE_DELIVERY_CONFIRMATION_MISSING: Telegram не подтвердил доставку результата расписания",
          );
        }
        await agentScheduleDispatchRepository.completeDeliveredRun({
          applicationSessionId: sessionId,
          content: message,
          deliveredAt,
          eveSessionId: ctx.session.id,
          familyId: scheduledDelivery.familyId,
          groupId: scheduledDelivery.groupId,
          messageThreadId: scheduledDelivery.messageThreadId,
          ownerUserId: scheduledDelivery.ownerUserId,
          runId: scheduledDelivery.runId,
          scheduledFor: new Date(scheduledDelivery.scheduledFor),
          scope: scheduledDelivery.scope,
          telegramChatId: scheduledDelivery.telegramChatId,
          telegramMessageId: firstMessage.messageId,
          title: scheduledDelivery.title,
        });
      }
      const conversationId = typeof currentAttributes?.telegramConversationId === "string"
        ? currentAttributes.telegramConversationId
        : null;
      if ((conversationId || groupId) && data.finishReason === "stop") {
        const replyToEntryId = typeof currentAttributes?.telegramTimelineEntryId === "string"
          ? currentAttributes.telegramTimelineEntryId
          : null;
        const forumTopicId = scheduledDelivery?.forumTopicId ??
          (typeof currentAttributes?.telegramForumTopicId === "string"
            ? currentAttributes.telegramForumTopicId
            : null);
        // The primary delivery receipt is durable before this secondary conversation projection.
        if (groupId) {
          await telegramGroupJournalRepository.recordAgentResponse({
            applicationSessionId: isScheduledSession(ctx) ? null : sessionId,
            contentText: message,
            deliveredAt,
            groupId,
            messageThreadId: forumTopicId,
            replyToEntryId,
            telegramMessageIds: sentMessages.map((sent) => sent.messageId),
          });
        } else if (conversationId) {
          await conversationTimelineRepository.recordAgentResponse({
            applicationSessionId: sessionId,
            contentText: message,
            conversationId,
            deliveredAt,
            messageThreadId: null,
            replyToEntryId,
            telegramMessageIds: sentMessages.map((sent) => sent.messageId),
          });
        }
      }
      if (!isScheduledSession(ctx)) {
        await registerTelegramDeliveredMessageRoutes(
          channel,
          ctx,
          sentMessages.map((sent) => sent.messageId),
        );
      }
    },
    async "session.failed"(data, channel) {
      await handleTelegramSessionFailure(data, channel, sessionRepository);
    },
    async "turn.failed"(data, channel, ctx) {
      const sessionId = applicationSessionId(ctx);
      if (isScheduledSession(ctx)) {
        await agentScheduleDispatchRepository.failRun(
          sessionId,
          ctx.session.id,
          data.code,
          new Date(),
        );
      }
      // A final send that started may already be visible; never append a second failure message.
       const finalDeliveryMayBeVisible =
         await telegramFinalDeliveryRepository.shouldSuppressFailureMessage(ctx.session.turn.id);
       if (!finalDeliveryMayBeVisible) {
        const replyParameters = isScheduledSession(ctx)
          ? undefined
          : telegramTurnReplyParameters(channel.state, ctx);
        const failureMessageId = await postTelegramMessageWithoutContinuationChange(channel, {
          ...(replyParameters === undefined ? {} : { reply_parameters: replyParameters }),
          text: formatTelegramTurnFailure(data),
        });
        if (!isScheduledSession(ctx)) {
          await registerTelegramDeliveredMessageRoutes(channel, ctx, [failureMessageId]);
        }
      }
      await sessionRepository.recordTurnFailed(sessionId, ctx.session.id);
      await telegramHitlApprovalRepository.clearForEveSession(sessionId, ctx.session.id);
    },
    async "turn.started"(_data, _channel, ctx) {
      const sessionId = applicationSessionId(ctx);
      await sessionRepository.bindEveSession(sessionId, ctx.session.id);
      const attributes = ctx.session.auth.current?.attributes;
      const pendingApprovalRefs = attributes?.pendingMemoryApprovalRefs;
      const pendingApprovalClaimToken = attributes?.pendingMemoryApprovalClaimToken;
      if (
        Array.isArray(pendingApprovalRefs) &&
        pendingApprovalRefs.every((value): value is string => typeof value === "string") &&
        typeof pendingApprovalClaimToken === "string"
      ) {
        await memoryApprovalNoticeRepository.confirmPresented(
          pendingApprovalRefs,
          pendingApprovalClaimToken,
        );
      }
      const conversationId = attributes?.telegramConversationId;
      const visibleEntryIds = attributes?.telegramTimelineVisibleEntryIds;
      if (
        typeof conversationId === "string" &&
        Array.isArray(visibleEntryIds) &&
        visibleEntryIds.every((value): value is string => typeof value === "string")
      ) {
        const callerTelegramUserId = attributes?.telegramUserId;
        if (typeof callerTelegramUserId !== "string") {
          throw new AppError(
            "AGENT_MEMORY_EXTRACTION_CALLER_MISSING",
            "Не удалось определить инициатора извлечения памяти из Telegram",
          );
        }
        // Snapshot the exact durable model input before the conversation cursor can move past it.
        await createTurnExtractionBatch({
          applicationSessionId: sessionId,
          callerTelegramUserId,
          conversationId,
          entryIds: visibleEntryIds,
          omittedBeforeSequence:
            typeof attributes?.telegramTimelineOmittedBeforeSequence === "string"
              ? attributes.telegramTimelineOmittedBeforeSequence
              : null,
          turnId: ctx.session.turn.id,
        });
      }
      const timelineSequence = attributes?.telegramTimelineSequence;
      if (typeof timelineSequence === "string") {
        await groupTimelineCursorRepository.advance(
          sessionId,
          ctx.session.id,
          timelineSequence,
        );
      }
      const proactiveDeliveryCursor = attributes?.proactiveDeliveryCursor;
      if (typeof proactiveDeliveryCursor === "string") {
        await proactiveDeliveryRepository.advanceSessionCursor(
          sessionId,
          proactiveDeliveryCursor,
        );
      }
    },
    async "turn.completed"(_data, channel, ctx) {
      const sessionId = applicationSessionId(ctx);
      const awaitingApproval = await sessionRepository.hasPendingOperation(sessionId, ctx.session.id);
      if (isScheduledSession(ctx) && !awaitingApproval) {
        // Successful scheduled runs are completed atomically with Telegram delivery above.
        await agentScheduleDispatchRepository.failRun(
          sessionId,
          ctx.session.id,
          "AGENT_SCHEDULE_DELIVERY_CONFIRMATION_MISSING",
          new Date(),
        );
      }
      await sessionRepository.recordTurnCompleted(sessionId, ctx.session.id, awaitingApproval);
      if (!awaitingApproval) {
        await telegramHitlApprovalRepository.clearForEveSession(sessionId, ctx.session.id);
      }
    },
    async "authorization.required"(_data, _channel, ctx) {
      const sessionId = applicationSessionId(ctx);
      const auth = ctx.session.auth.current;
      const telegramUserId = auth?.attributes.telegramUserId;
      await sessionRepository.parkSession({
        applicationSessionId: sessionId,
        pendingRequestId: null,
        requesterTelegramUserId: typeof telegramUserId === "string" ? telegramUserId : null,
        requesterUserId: auth && UUID_PATTERN.test(auth.principalId) ? auth.principalId : null,
      });
    },
    async "authorization.completed"(_data, _channel, ctx) {
      await sessionRepository.resumePendingSession(applicationSessionId(ctx), ctx.session.id);
    },
  },
  onDrain: handleTelegramDurableIngress.drain,
  onHitlCallbackQuery: authorizeTelegramHitlCallback,
  onMessage: handleTelegramMessage,
  onVerifiedUpdate: handleTelegramDurableIngress,
  // The application persists authorized files before dispatch. The primary model receives only
  // trusted workspace paths and invokes the dedicated vision model when image analysis is needed.
  uploadPolicy: TELEGRAM_EVE_UPLOAD_POLICY,
});
