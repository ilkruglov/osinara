/**
 * Workspace-to-Telegram file sender tool.
 *
 * Export:
 * - Eve `send_workspace_file` tool with current-scope authorization and durable delivery guard.
 */
import { basename } from "node:path";

import { defineTool } from "eve/tools";
import { z } from "zod";

import { isAppError } from "../lib/app-error.js";
import { deliverWorkspaceFile } from "../lib/attachments/telegram-workspace-file-delivery.js";
import {
  requireTelegramDeliveryTarget,
  requireWorkspaceAuthorization,
} from "../lib/workspaces/workspace-context.js";
import { workspaceFileDeliveryRepository } from "../lib/workspaces/workspace-file-delivery-repository.js";
import { telegramGroupJournalRepository } from "../lib/telegram-group-journal-repository.js";
import {
  applicationSessionId,
  registerTelegramMessageRoutes,
} from "../lib/sessions/session-context.js";

export default defineTool({
  description: "Отправить файл из доступного workspace в текущий Telegram-чат или тему.",
  inputSchema: z.object({
    caption: z.string().max(1_024).optional(),
    path: z.string().min(1).max(512),
    presentation: z.enum(["document", "photo"]),
    scope: z.enum(["personal", "family", "group"]),
  }),
  async execute(input, ctx) {
    const auth = requireWorkspaceAuthorization(ctx);
    const target = requireTelegramDeliveryTarget(ctx);
    const reservation = await workspaceFileDeliveryRepository.begin(auth, {
      ...target,
      operationKey: ctx.callId,
      path: input.path,
      presentation: input.presentation,
      scope: input.scope,
    });
    const replayed = reservation.status === "completed";
    let delivery: { telegramMessageId: string };
    if (replayed) {
      delivery = { telegramMessageId: reservation.telegramMessageId };
    } else {
      try {
        delivery = await deliverWorkspaceFile({
          bytes: reservation.bytes,
          ...(input.caption === undefined ? {} : { caption: input.caption }),
          ...target,
          fileName: basename(reservation.file.path),
          mediaType: reservation.file.mediaType,
          presentation: input.presentation,
        });
      } catch (error) {
        // Definitive validation/provider failures may be retried only through a new user request.
        if (isAppError(error) && error.code !== "AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS") {
          await workspaceFileDeliveryRepository.fail(ctx.callId, error.code);
        }
        throw error;
      }
      await workspaceFileDeliveryRepository.complete(ctx.callId, delivery.telegramMessageId);
    }
    if (auth.groupId !== null) {
      const sessionId = applicationSessionId(ctx);
      const fileName = basename(reservation.file.path);
      const forumTopicId = ctx.session.auth.current?.attributes.telegramForumTopicId;
      if (forumTopicId !== undefined &&
        (typeof forumTopicId !== "string" || !/^[1-9][0-9]*$/u.test(forumTopicId))) {
        throw new Error(
          "AGENT_TELEGRAM_FORUM_TOPIC_INVALID: Не удалось определить тему для истории отправленного файла",
        );
      }
      // Tool deliveries bypass Telegram channel events, so project the confirmed side effect and
      // bind its message ID before a participant can reply to it.
      await telegramGroupJournalRepository.recordAgentResponse({
        applicationSessionId: sessionId,
        attachment: {
          fileName,
          kind: input.presentation,
          mediaType: reservation.file.mediaType,
          size: reservation.bytes.byteLength,
        },
        contentText: input.caption?.trim() || `Отправлен файл «${fileName}».`,
        deliveredAt: new Date(),
        groupId: auth.groupId,
        messageThreadId: forumTopicId ?? null,
        replyToEntryId: typeof ctx.session.auth.current?.attributes.telegramTimelineEntryId ===
            "string"
          ? ctx.session.auth.current.attributes.telegramTimelineEntryId
          : null,
        telegramMessageIds: [delivery.telegramMessageId],
      });
      await registerTelegramMessageRoutes({
        applicationSessionId: sessionId,
        chatId: target.chatId,
        messageIds: [delivery.telegramMessageId],
        ...(target.messageThreadId === undefined
          ? {}
          : { messageThreadId: target.messageThreadId }),
      });
    }
    return {
      delivered: true,
      path: reservation.file.path,
      replayed,
      scope: reservation.file.scope,
      telegramMessageId: delivery.telegramMessageId,
    };
  },
});
