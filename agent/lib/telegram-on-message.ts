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
 */
import type {
  TelegramContext,
  TelegramInboundResult,
  TelegramMessage,
} from "eve/channels/telegram";

import { downloadTelegramAttachment } from "./attachments/telegram-attachment-download.js";
import {
  telegramGroupAttachmentRepository,
  type TelegramGroupAttachmentRepository,
} from "./attachments/telegram-group-attachment-repository.js";
import {
  createTelegramWorkspaceAttachmentImporter,
  type StoredTelegramAttachment,
} from "./attachments/telegram-workspace-attachments.js";
import { isAppError } from "./app-error.js";
import { formatCurrentTimeContext } from "./current-time.js";
import { evaluateConversationAccess, type RegisteredGroup } from "./family-access.js";
import { familyRepository, type FamilyRepository } from "./family-repository.js";
import { parseInvitationStartCommand } from "./invitation-code.js";
import {
  proactiveDeliveryRepository,
} from "./proactive-deliveries/proactive-delivery-repository.js";
import {
  sessionRepository,
} from "./sessions/session-repository.js";
import { groupCanonicalContinuationToken } from "./sessions/group-canonical-token.js";
import {
  classifyTelegramInboundMedia,
  isMessageAddressedToBot,
  isReplyToBot,
} from "./telegram-message-policy.js";
import { parseExternalGroupToolAllowlist } from "./tool-policy/group-tool-catalog.js";
import {
  telegramGroupTurnContextPreparer,
  type TelegramGroupTurnContextPreparer,
} from "./telegram-group-turn-context.js";
import { telegramForumTopicId } from "./telegram-group-message-storage.js";
import {
  telegramGroupJournalRepository,
  type TelegramGroupJournalRepository,
} from "./telegram-group-journal-repository.js";
import { telegramRepository, type TelegramRepository } from "./telegram-repository.js";
import {
  formatStoredTelegramAttachments,
  formatTelegramAttachmentReferences,
  telegramAttachmentScope,
  telegramProactiveDeliveryAuthorization,
  telegramProfileName,
  telegramSessionScope,
  telegramWorkspaceAuthorization,
} from "./telegram-on-message-context.js";
import {
  telegramBaseContinuationToken,
  telegramReplyContinuationTokens,
} from "./telegram-reply-routing.js";
import {
  telegramHitlApprovalRepository,
  type TelegramHitlApprovalRepository,
} from "./telegram-hitl/approval-repository.js";
import { workspaceBinaryRepository } from "./workspaces/workspace-binary-repository.js";
import type {
  WorkspaceAuthorization,
  WorkspaceScope,
} from "./workspaces/workspace-repository.js";

interface TelegramMessageRepositories {
  attachmentReferences: Pick<TelegramGroupAttachmentRepository, "record">;
  attachments: {
    persist(input: {
      attachments: readonly TelegramMessage["attachments"][number][];
      auth: WorkspaceAuthorization;
      chatId: string;
      messageId: string;
      scope: WorkspaceScope;
    }): Promise<StoredTelegramAttachment[]>;
  };
  family: Pick<FamilyRepository, "claimInvitation">;
  groupContext: { prepare: TelegramGroupTurnContextPreparer };
  hitl: Pick<TelegramHitlApprovalRepository, "authorizeReply">;
  journal: Pick<TelegramGroupJournalRepository, "record">;
  proactiveDeliveries: Pick<typeof proactiveDeliveryRepository, "listPendingContext">;
  session: Pick<typeof sessionRepository, "hasRoute" | "prepareTurn">;
  telegram: TelegramRepository;
}

function sameGroupPolicy(left: RegisteredGroup, right: RegisteredGroup | null): boolean {
  if (!right) return false;
  if (
    left.familyId !== right.familyId ||
    left.groupId !== right.groupId ||
    left.messageMode !== right.messageMode ||
    left.telegramChatId !== right.telegramChatId ||
    left.type !== right.type ||
    left.toolAllowlist.length !== right.toolAllowlist.length
  ) return false;
  return left.toolAllowlist.every((capability, index) => capability === right.toolAllowlist[index]);
}

export function createTelegramMessageHandler(repositories: TelegramMessageRepositories) {
  return async function handleMessage(
    ctx: TelegramContext,
    message: TelegramMessage,
  ): Promise<TelegramInboundResult> {
    const sender = message.from;
    if (!sender || sender.isBot || message.chat.type === "channel") return null;

    // Resolve invocation from verified channel data before any identity or model work.
    const botUsername = ctx.telegram.botUsername;
    if (!botUsername) {
      throw new Error("AGENT_TELEGRAM_CONFIG_MISSING: Не задано имя Telegram-бота");
    }
    const dispatchText = [message.text, message.caption].filter(Boolean).join("\n");
    let addressed = isMessageAddressedToBot({ ...message, text: dispatchText }, botUsername);
    let verifiedReplyRoute: string | undefined;
    let exactReplyRoute: string | undefined;
    let hasResumableReplyRoute = false;
    let resumesPendingTask = false;

    const invitationCode = parseInvitationStartCommand(message.text);
    if (invitationCode && message.chat.type !== "private") {
      // Leaked deep links in any group are dropped silently before identity or session work.
      return null;
    }

    // Registered group policy is required before passive messages may be persisted.
    const group =
      message.chat.type === "private"
        ? null
        : await repositories.telegram.findGroup(message.chat.id);
    const forumTopicId = group ? telegramForumTopicId(message) : null;
    const mediaKind = classifyTelegramInboundMedia(message);
    const externalAllowlist = group?.type !== "family_private"
      ? parseExternalGroupToolAllowlist(group?.toolAllowlist)
      : null;
    const externalNativePhotoAllowed = mediaKind === "native_photo" &&
      externalAllowlist?.has("inspect_workspace_image") === true;
    let journalDuplicate = false;
    let inboundTimeline: Awaited<ReturnType<TelegramGroupJournalRepository["record"]>> | null = null;
    const hasLazyFamilyAttachment =
      group?.type === "family_private" && message.attachments.length > 0;
    if (message.chat.type !== "private") {
      if (!group) return null;
      // External media is fail-closed except for a current, explicitly allowlisted native photo.
      if (group.type !== "family_private" && mediaKind !== "none" && !externalNativePhotoAllowed) {
        return null;
      }
      // Every registered group shares one timeline independently of whether this message starts a turn.
      inboundTimeline = await repositories.journal.record(group.groupId, message);
      if (inboundTimeline.status === "duplicate") {
        journalDuplicate = true;
        if (!hasLazyFamilyAttachment) return null;
      }
      if (inboundTimeline.replyToAgent) addressed = true;
      const routeEligibleReply = message.replyToMessage &&
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
      if (!addressed && !hasLazyFamilyAttachment) return null;
    } else if (!addressed) {
      return null;
    }

    const identity = await repositories.telegram.findIdentity(sender.id);

    // Group policy and identity are separate DB records. Re-reading the group establishes a
    // fail-closed authorization boundary if owner-only mode, type, or capabilities changed while
    // the incoming message was journaled and participant identity was resolved.
    if (group && !sameGroupPolicy(group, await repositories.telegram.findGroup(message.chat.id))) {
      return null;
    }

    // Owner-only external groups retain everyone's timeline but dispatch solely for the current
    // persisted Osinara owner; Telegram administrator status never grants application authority.
    if (
      group?.messageMode === "owner_only" &&
      (
        identity?.familyId !== group.familyId ||
        identity.role !== "owner"
      )
    ) return null;

    // Invitation secrets never become ordinary turns, including when opened by an existing member.
    if (identity && invitationCode) {
      await ctx.telegram.sendMessage(
        "AGENT_INVITATION_NOT_APPLICABLE: Вы уже подключены к семейному агенту.",
      );
      return null;
    }

    if (!identity && message.chat.type === "private") {
      const ownerConfigured = await repositories.telegram.hasOwner();

      // Bootstrap plaintext is consumed entirely at the channel boundary and never reaches Eve.
      if (!ownerConfigured) {
        const code = message.text.trim();
        const claim = code
          ? await repositories.telegram.claimFirstOwner(code, {
              displayName: telegramProfileName(message),
              telegramUserId: sender.id,
              ...(sender.username ? { username: sender.username } : {}),
            })
          : "invalid";
        if (claim === "claimed") {
          await ctx.telegram.sendMessage("Владелец создан. Семейный агент готов к настройке.");
          return null;
        }
        await ctx.telegram.sendMessage(
          "AGENT_BOOTSTRAP_CODE_INVALID: Код недействителен или истек. Создайте новый код на сервере.",
        );
        return null;
      }

      // Only a strict Telegram deep-link command can enter the invitation verifier.
      if (invitationCode) {
        const claim = await repositories.family.claimInvitation(invitationCode, {
          displayName: telegramProfileName(message),
          telegramUserId: sender.id,
          ...(sender.username ? { username: sender.username } : {}),
        });
        if (claim === "pending") {
          await ctx.telegram.sendMessage(
            "AGENT_INVITATION_PENDING: Заявка отправлена владельцу. Доступ появится после подтверждения.",
          );
          return null;
        }
      }

      await ctx.telegram.sendMessage(
        "AGENT_ACCESS_DENIED: У вас нет доступа. Попросите владельца отправить приглашение.",
      );
      return null;
    }

    // Auth attributes carry only values derived from the verified webhook and persisted policy.
    const decision = evaluateConversationAccess({
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

    // Family media stays remote until the model explicitly imports this safe opaque reference.
    const lazyAttachment = hasLazyFamilyAttachment && group
      ? await repositories.attachmentReferences.record(group.groupId, message)
      : null;
    if (!addressed || journalDuplicate) return null;

    let replyHandling: "message" | undefined;
    // A persisted agent timeline anchor is trusted even when Telegram omits compact sender metadata.
    const trustedAgentReply = inboundTimeline?.replyToAgent === true;
    const replyTarget = message.replyToMessage;
    if (replyTarget?.from?.isBot === true || trustedAgentReply) {
      if (!replyTarget) {
        throw new Error(
          "AGENT_TELEGRAM_REPLY_TARGET_MISSING: Для проверки ответа отсутствует Telegram-сообщение назначения",
        );
      }
      const replyAuthorization = await repositories.hitl.authorizeReply({
        baseContinuationToken: telegramBaseContinuationToken(
          message,
          verifiedReplyRoute ?? (trustedAgentReply ? exactReplyRoute : undefined),
        ),
        telegramChatId: message.chat.id,
        telegramMessageId: replyTarget.messageId,
        telegramUserId: sender.id,
      });
      if (replyAuthorization === "forbidden" || replyAuthorization === "expired") {
        const error = replyAuthorization === "forbidden"
          ? "AGENT_APPROVAL_FORBIDDEN: Подтвердить действие может только пользователь, который его запросил."
          : "AGENT_APPROVAL_EXPIRED: Это подтверждение уже использовано или больше не действует.";
        await ctx.telegram.sendMessage(error);
        return null;
      }
      // DB authorization, not a pre-rotation route snapshot, decides whether this is synthetic HITL.
      // Tool-delivered photos/documents are not projected by the final text-delivery event. The
      // verified Telegram sender still proves that this is an ordinary reply to Osinara, not HITL.
      const ordinaryAgentReply = trustedAgentReply ||
        message.chat.type === "private" ||
        isReplyToBot(message, botUsername);
      if (replyAuthorization === "not_applicable" && ordinaryAgentReply) {
        if (!hasResumableReplyRoute) verifiedReplyRoute = exactReplyRoute;
        replyHandling = "message";
      }
      if (replyAuthorization === "authorized") resumesPendingTask = true;
    }

    let storedAttachments: StoredTelegramAttachment[] = [];
    if (
      message.attachments.length > 0 &&
      (message.chat.type === "private" || externalNativePhotoAllowed)
    ) {
      try {
        storedAttachments = await repositories.attachments.persist({
          attachments: message.attachments,
          auth: telegramWorkspaceAuthorization(decision, group, message),
          chatId: message.chat.id,
          messageId: message.messageId,
          scope: telegramAttachmentScope(decision),
        });
      } catch (error) {
        // The channel boundary informs the user, while rethrowing preserves terminal ingress failure.
        if (isAppError(error)) await ctx.telegram.sendMessage(error.message);
        throw error;
      }
    }
    // One instant anchors session rotation, pending-delivery visibility, and model-visible time.
    const turnStartedAt = new Date();
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
    const groupTurnContext = group && inboundTimeline
      ? await repositories.groupContext.prepare({
          applicationSessionId: appSession.id,
          currentEntryId: inboundTimeline.entryId,
          currentSenderDisplayName: telegramProfileName(message),
          currentSenderUsername: sender.username ?? null,
          currentSequence: inboundTimeline.sequenceId,
          groupId: group.groupId,
          messageText: dispatchText,
          messageThreadId: forumTopicId,
        })
      : null;
    const principalId = access.userId ?? `telegram:${sender.id}`;
    const context = [
      `Verified conversation scope: ${access.memoryScopes.join(", ")}.`,
      `Verified role: ${access.role}.`,
      "Verified Telegram delivery: reply in concise Rich Markdown; the channel safely supports Markdown tables and approved text-rich structure.",
      formatCurrentTimeContext(turnStartedAt),
    ];
    if (storedAttachments.length > 0) {
      context.push(formatStoredTelegramAttachments(storedAttachments));
    }
    if (lazyAttachment) context.push(formatTelegramAttachmentReferences([lazyAttachment]));
    if (pendingDeliveries) context.push(pendingDeliveries.context);

    return {
      auth: {
        attributes: {
          familyId: access.familyId,
          applicationSessionId: appSession.id,
          memoryScopes: access.memoryScopes,
          role: access.role,
          sandboxSessionId: appSession.sandboxSessionId,
          ...(pendingDeliveries
            ? { proactiveDeliveryCursor: pendingDeliveries.cursor }
            : {}),
          telegramChatId: message.chat.id,
          telegramChatType: message.chat.type,
          telegramMessageId: message.messageId,
          ...(message.chat.type === "private"
            ? {}
            : { telegramReplyToMessageId: message.messageId }),
          ...(inboundTimeline ? { telegramTimelineEntryId: inboundTimeline.entryId } : {}),
          ...(groupTurnContext
            ? { telegramGroupTimelineSequence: groupTurnContext.cursorSequence }
            : {}),
          ...(forumTopicId === null ? {} : { telegramForumTopicId: forumTopicId }),
          ...(message.messageThreadId === undefined
            ? {}
            : { telegramMessageThreadId: String(message.messageThreadId) }),
          telegramUserId: sender.id,
          ...(group ? { groupType: group.type } : {}),
          ...(group && group.type !== "family_private"
            ? { toolAllowlist: group.toolAllowlist }
            : {}),
          ...(access.groupId ? { groupId: access.groupId } : {}),
        },
        authenticator: "telegram",
        principalId,
        principalType: "user",
      },
      context,
      continuationToken: appSession.continuationToken,
      ...(groupTurnContext ? { message: groupTurnContext.durableMessage } : {}),
      ...(replyHandling === undefined ? {} : { replyHandling }),
    };
  };
}

export const handleTelegramMessage = createTelegramMessageHandler({
  attachmentReferences: telegramGroupAttachmentRepository,
  attachments: createTelegramWorkspaceAttachmentImporter({
    download: downloadTelegramAttachment,
    writeBinary: workspaceBinaryRepository.writeBinary,
  }),
  family: familyRepository,
  groupContext: { prepare: telegramGroupTurnContextPreparer },
  hitl: telegramHitlApprovalRepository,
  journal: telegramGroupJournalRepository,
  proactiveDeliveries: proactiveDeliveryRepository,
  session: sessionRepository,
  telegram: telegramRepository,
});
