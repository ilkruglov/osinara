/**
 * Shared workspace-to-Telegram sender behind the image and document tools.
 *
 * Export:
 * - `createWorkspaceSendTool`: one delivery body bound to a fixed Telegram presentation.
 *
 * Key constructs:
 * - The presentation belongs to the tool, never to the model: an image tool sends photos and a
 *   file tool sends documents, so one file can no longer arrive twice in two shapes.
 * - Identical bytes already delivered to this chat in this turn report the first message instead
 *   of sending again.
 */
import { basename } from "node:path";

import { defineTool } from "eve/tools";
import { z } from "zod";

import { AppError, isAppError } from "../app-error.js";
import { deliverWorkspaceFile } from "./telegram-workspace-file-delivery.js";
import {
  requireTelegramDeliveryTarget,
  requireWorkspaceAuthorization,
} from "../workspaces/workspace-context.js";
import { workspaceFileDeliveryRepository } from "../workspaces/workspace-file-delivery-repository.js";
import { telegramGroupJournalRepository } from "../telegram-group-journal-repository.js";
import {
  applicationSessionId,
  registerTelegramMessageRoutes,
} from "../sessions/session-context.js";
import { turnKey } from "../model-facing-tool.js";

export function createWorkspaceSendTool(options: {
  description: string;
  pathExample: string;
  presentation: "document" | "photo";
}) {
  return defineTool({
    description: options.description,
    inputSchema: z.object({
      caption: z.string().max(1_024).optional().describe("Необязательная подпись Telegram"),
      path: z.string().min(1).max(512).describe(
        `Относительный путь внутри выбранного scope, например ${options.pathExample}`,
      ),
      scope: z.enum(["personal", "family", "group"]).describe(
        "Workspace, относительно которого задан path",
      ),
    }).strict(),
    async execute(input, ctx) {
      const auth = requireWorkspaceAuthorization(ctx);
      const target = requireTelegramDeliveryTarget(ctx);
      const forumTopicId = ctx.session.auth.current?.attributes.telegramForumTopicId;
      if (forumTopicId !== undefined &&
        (typeof forumTopicId !== "string" || !/^[1-9][0-9]*$/u.test(forumTopicId))) {
        throw new AppError(
          "AGENT_TELEGRAM_FORUM_TOPIC_INVALID",
          "Не удалось определить тему для истории отправленного файла",
        );
      }
      const reservation = await workspaceFileDeliveryRepository.begin(auth, {
        ...target,
        operationKey: ctx.callId,
        path: input.path,
        presentation: options.presentation,
        scope: input.scope,
        turnId: turnKey(ctx),
      });

      // The bytes are already in the chat from an earlier call this turn; the journal and the
      // message routes were recorded then, so nothing is left to do but point at that message.
      if (reservation.status === "duplicate") {
        return {
          alreadySent: true,
          delivered: true,
          path: reservation.file.path,
          persistenceCompleted: true,
          projectionCompleted: true,
          replayed: false,
          retryable: false,
          scope: reservation.file.scope,
          sideEffectStatus: "completed" as const,
          telegramMessageId: reservation.telegramMessageId,
        };
      }

      const replayed = reservation.status === "completed";
      let persistenceCompleted = replayed;
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
            presentation: options.presentation,
          });
        } catch (error) {
          // Definitive validation/provider failures may be retried only through a new user request.
          if (isAppError(error) && error.code !== "AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS") {
            await workspaceFileDeliveryRepository.fail(ctx.callId, error.code);
          }
          throw error;
        }
        try {
          await workspaceFileDeliveryRepository.complete(ctx.callId, delivery.telegramMessageId);
          persistenceCompleted = true;
        } catch (error) {
          // Telegram confirmed delivery, so a bookkeeping error must not turn into a retryable send.
          console.error(JSON.stringify({
            code: "AGENT_WORKSPACE_FILE_COMPLETION_FAILED",
            error: error instanceof Error ? error.message : String(error),
            telegramMessageId: delivery.telegramMessageId,
          }));
        }
      }
      let projectionCompleted = true;
      if (auth.groupId !== null) {
        const sessionId = applicationSessionId(ctx);
        const fileName = basename(reservation.file.path);
        // Tool deliveries bypass Telegram channel events, so project the confirmed side effect and
        // bind its message ID before a participant can reply to it.
        try {
          await telegramGroupJournalRepository.recordAgentResponse({
            applicationSessionId: sessionId,
            attachment: {
              fileName,
              kind: options.presentation,
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
        } catch (error) {
          // Telegram already confirmed the side effect; surfacing an error would invite a duplicate send.
          projectionCompleted = false;
          console.error(JSON.stringify({
            code: "AGENT_WORKSPACE_FILE_PROJECTION_FAILED",
            error: error instanceof Error ? error.message : String(error),
            telegramMessageId: delivery.telegramMessageId,
          }));
        }
      }
      return {
        alreadySent: false,
        delivered: true,
        path: reservation.file.path,
        persistenceCompleted,
        projectionCompleted,
        replayed,
        retryable: false,
        scope: reservation.file.scope,
        sideEffectStatus: "completed" as const,
        telegramMessageId: delivery.telegramMessageId,
      };
    },
  });
}
