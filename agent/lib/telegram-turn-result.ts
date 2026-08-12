/**
 * Final trusted Telegram inbound result assembly.
 *
 * Exports:
 * - `buildTelegramTurnResult`: composes internal auth attributes and bounded model context.
 */
import type { TelegramInboundResult, TelegramMessage } from "eve/channels/telegram";

import type { StoredTelegramAttachment } from "./attachments/telegram-workspace-attachments.js";
import { formatCurrentTimeContext } from "./current-time.js";
import type { ApplicationConversation } from "./conversation-repository.js";
import type { ConversationAccess, RegisteredGroup } from "./family-access.js";
import type { PreparedTelegramGroupTurnContext } from "./telegram-group-turn-context.js";
import type { TelegramGroupAttachmentSummary } from "./telegram-group-journal-context.js";
import type { PreparedSession } from "./sessions/session-repository.js";
import {
  formatStoredTelegramAttachments,
  formatTelegramAttachmentReferences,
} from "./telegram-on-message-context.js";

export function buildTelegramTurnResult(input: {
  access: ConversationAccess;
  appSession: PreparedSession;
  conversation: ApplicationConversation;
  forumTopicId: string | null;
  group: RegisteredGroup | null;
  lazyAttachment: (TelegramGroupAttachmentSummary & { telegramMessageId: string }) | null;
  message: TelegramMessage;
  pendingDelivery: { context: string; cursor: string } | null;
  profileReplyTimelineSequence: string | null;
  profileSignals: {
    explicitMentionTelegramUserIds: readonly string[];
    replyTelegramUserId: string | null;
  };
  replyHandling: "message" | undefined;
  storedAttachments: readonly StoredTelegramAttachment[];
  timelineEntryId: string;
  turnContext: PreparedTelegramGroupTurnContext;
  turnStartedAt: Date;
}): TelegramInboundResult {
  const sender = input.message.from;
  if (!sender) throw new Error("AGENT_TELEGRAM_MESSAGE_INVALID: Telegram не передал отправителя");
  const context = [
    `Verified conversation scope: ${input.access.memoryScopes.join(", ")}.`,
    `Verified role: ${input.access.role}.`,
    "Verified Telegram delivery: reply in concise plain text by default; use supported Rich Markdown only when formatting materially improves the answer.",
    formatCurrentTimeContext(input.turnStartedAt),
  ];
  if (input.storedAttachments.length > 0) {
    context.push(formatStoredTelegramAttachments(input.storedAttachments));
  }
  if (input.lazyAttachment) context.push(formatTelegramAttachmentReferences([input.lazyAttachment]));
  if (input.pendingDelivery) context.push(input.pendingDelivery.context);

  return {
    auth: {
      attributes: {
        applicationSessionId: input.appSession.id,
        familyId: input.access.familyId,
        ...(input.access.groupId ? { groupId: input.access.groupId } : {}),
        ...(input.group ? { groupType: input.group.type } : {}),
        memoryScopes: input.access.memoryScopes,
        ...(input.pendingDelivery ? { proactiveDeliveryCursor: input.pendingDelivery.cursor } : {}),
        role: input.access.role,
        sandboxSessionId: input.appSession.sandboxSessionId,
        telegramChatId: input.message.chat.id,
        telegramChatType: input.message.chat.type,
        telegramConversationId: input.conversation.id,
        ...(input.forumTopicId === null ? {} : { telegramForumTopicId: input.forumTopicId }),
        telegramMessageId: input.message.messageId,
        ...(input.profileSignals.explicitMentionTelegramUserIds.length === 0
          ? {}
          : { telegramProfileMentionUserIds: input.profileSignals.explicitMentionTelegramUserIds }),
        ...(input.profileSignals.replyTelegramUserId === null
          ? {}
          : { telegramProfileReplyUserId: input.profileSignals.replyTelegramUserId }),
        ...(input.profileReplyTimelineSequence === null
          ? {}
          : { telegramProfileReplyTimelineSequence: input.profileReplyTimelineSequence }),
        telegramTurnStartedAt: input.turnStartedAt.toISOString(),
        ...(input.message.messageThreadId === undefined
          ? {}
          : { telegramMessageThreadId: String(input.message.messageThreadId) }),
        ...(input.message.chat.type === "private"
          ? {}
          : { telegramReplyToMessageId: input.message.messageId }),
        ...(input.turnContext.omittedBeforeSequence === null
          ? {}
          : { telegramTimelineOmittedBeforeSequence: input.turnContext.omittedBeforeSequence }),
        telegramTimelineEntryId: input.timelineEntryId,
        telegramTimelineSequence: input.turnContext.cursorSequence,
        telegramTimelineVisibleEntryIds: input.turnContext.visibleEntryIds,
        ...(input.turnContext.memoryReviewBatchId === undefined
          ? {}
          : { memoryReviewBatchId: input.turnContext.memoryReviewBatchId }),
        ...(input.turnContext.memoryReviewBatchId === undefined
          ? {}
          : { memoryReviewMode: "interactive" }),
        ...(input.turnContext.memoryReviewSourceEntryIds === undefined
          ? {}
          : { memoryReviewSourceEntryIds: input.turnContext.memoryReviewSourceEntryIds }),
        telegramUserId: sender.id,
        ...(input.group && input.group.type !== "family_private"
          ? { toolAllowlist: input.group.toolAllowlist }
          : {}),
      },
      authenticator: "telegram",
      principalId: input.access.userId ?? `telegram:${sender.id}`,
      principalType: "user",
    },
    context,
    continuationToken: input.appSession.continuationToken,
    message: input.turnContext.durableMessage,
    ...(input.replyHandling === undefined ? {} : { replyHandling: input.replyHandling }),
  };
}
