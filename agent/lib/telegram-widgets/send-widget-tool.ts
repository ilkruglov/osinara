/**
 * Mia's own Telegram widgets: a self-contained HTML card from the workspace, sent into the chat.
 *
 * Exports:
 * - `sendWidgetTool`: the Eve `send_widget` tool.
 * - `EXTERNAL_SEND_WIDGET_PRESENTATION`: its description and group-only schema in an external group.
 *
 * Key constructs:
 * - The card is a workspace file, never an argument: Mia writes and rewrites it with the file
 *   tools, the tool reads the exact bytes once. The delivery reservation, replay and per-turn
 *   duplicate check are the ones photos and documents use (`presentation: "widget"`).
 * - Everything that would break the card is refused before Telegram with a correction: over 32 KB
 *   or 4 KB compressed, network resources, SVG as an image, network calls, any link where links are
 *   not allowed. What Telegram drops silently comes back as warnings; every link the card can open
 *   comes back too, so a planted address is visible in the turn.
 * - The caption is required: older clients and previews show only it, and the group journal keeps it
 *   as Mia's message. The result names it as already sent, or the model retells the card in text.
 * - Telegram's refusal is a definite failure; a request that threw, a server error or a success
 *   without the message id may have delivered the card, so the row stays started and a retry
 *   reports ambiguity instead of sending a second card. A replayed step whose card went out writes
 *   the chat journal and routes again: the process may have died between the two.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { isScheduledSession } from "../agent-schedules/scheduled-session.js";
import { ModelFacingError } from "../model-facing-error.js";
import { turnKey } from "../model-facing-tool.js";
import {
  applicationSessionId,
  registerTelegramMessageRoutes,
} from "../sessions/session-context.js";
import { telegramGroupJournalRepository } from "../telegram-group-journal-repository.js";
import { TELEGRAM_SILENT_DIRECTIVE } from "../telegram-progress.js";
import {
  requireTelegramDeliveryTarget,
  requireWorkspaceAuthorization,
} from "../workspaces/workspace-context.js";
import { workspaceFileDeliveryRepository } from "../workspaces/workspace-file-delivery-repository.js";
import { requireTelegramWidgetSize } from "./telegram-widget-limits.js";
import { lintTelegramWidget } from "./telegram-widget-lint.js";
import { sendTelegramWidget } from "./telegram-widget-send.js";

const CAPTION_SENT_NOTE = `Подпись уже в чате вместе с виджетом. В следующем сообщении пиши только то, чего нет ни в карточке, ни в подписи, без «Готово» и без пересказа карточки; если добавить нечего, ответь ровно ${TELEGRAM_SILENT_DIRECTIVE}, сервер его не отправит.`;
// A scheduled run is completed only by its final text (`channels/telegram.ts`): no silence there.
const SCHEDULED_CAPTION_SENT_NOTE =
  "Подпись уже в чате вместе с виджетом. Итоговое сообщение расписания обязательно: напиши коротко то, чего нет ни в карточке, ни в подписи, без «Готово» и без пересказа карточки.";

function refused(code: string, reason: string, correction: string): ModelFacingError {
  return new ModelFacingError({
    category: "input",
    code,
    correction,
    reason,
    retryable: true,
    sideEffectStatus: "not_started",
  });
}

function telegramDescription(body: unknown): string {
  const description = (body as { description?: unknown } | null)?.description;
  return typeof description === "string" ? description.slice(0, 200) : "без описания";
}

export const sendWidgetTool = defineTool({
  description: [
    "Отправить в текущий чат или тему виджет Telegram: карточку из HTML-файла workspace, которую Telegram рисует прямо в сообщении.",
    "Виджет ожидается для сводок с числами, таблиц, сравнений, графиков и карточек дня; разговорный ответ, шутка и короткая справка остаются обычным текстом.",
    "Перед первым виджетом загрузи навык telegram-widgets: там что умеет карточка, шаблоны и как уложиться в 4 КБ после сжатия.",
    "Вход: path к HTML-файлу внутри scope и caption — короткий итог карточки одной строкой, его видят превью и старые клиенты.",
    "Результат: delivered=true, telegramMessageId, size, links (все адреса, которые открывает карточка) и warnings (что Telegram выбросит); alreadySent=true значит, что эти байты уже ушли на этом ходе.",
    "Ошибка AGENT_TELEGRAM_WIDGET_TOO_LARGE или AGENT_TELEGRAM_WIDGET_INVALID: исправь файл и отправь заново. При sideEffectStatus completed или unknown повторно не отправляй.",
  ].join(" "),
  inputSchema: z
    .object({
      caption: z.string().trim().min(1).max(1_024).describe("Короткий итог карточки одной строкой"),
      path: z
        .string()
        .min(1)
        .max(512)
        .describe("Относительный путь к .html внутри scope, например widgets/day.html"),
      scope: z
        .enum(["personal", "family", "group"])
        .describe("Workspace, относительно которого задан path"),
    })
    .strict(),
  async execute(input, ctx) {
    const auth = requireWorkspaceAuthorization(ctx);
    const target = requireTelegramDeliveryTarget(ctx);
    const forumTopicId = ctx.session.auth.current?.attributes.telegramForumTopicId;
    if (
      forumTopicId !== undefined &&
      (typeof forumTopicId !== "string" || !/^[1-9][0-9]*$/u.test(forumTopicId))
    ) {
      throw new AppError(
        "AGENT_TELEGRAM_FORUM_TOPIC_INVALID",
        "Не удалось определить тему для истории отправленного виджета",
      );
    }
    const reservation = await workspaceFileDeliveryRepository.begin(auth, {
      ...target,
      operationKey: ctx.callId,
      path: input.path,
      presentation: "widget",
      scope: input.scope,
      turnId: turnKey(ctx),
    });

    /** The card as the group's message: in the journal and bound for replies. Never throws. */
    const project = async (messageId: string): Promise<boolean> => {
      if (auth.groupId === null) return true;
      const sessionId = applicationSessionId(ctx);
      try {
        await telegramGroupJournalRepository.recordAgentResponse({
          applicationSessionId: sessionId,
          contentText: `[виджет] ${input.caption}`,
          deliveredAt: new Date(),
          groupId: auth.groupId,
          messageThreadId: forumTopicId ?? null,
          replyToEntryId:
            typeof ctx.session.auth.current?.attributes.telegramTimelineEntryId === "string"
              ? ctx.session.auth.current.attributes.telegramTimelineEntryId
              : null,
          telegramMessageIds: [messageId],
        });
        await registerTelegramMessageRoutes({
          applicationSessionId: sessionId,
          chatId: target.chatId,
          messageIds: [messageId],
          ...(target.messageThreadId === undefined
            ? {}
            : { messageThreadId: target.messageThreadId }),
        });
        return true;
      } catch (error) {
        console.error(
          JSON.stringify({
            code: "AGENT_WORKSPACE_FILE_PROJECTION_FAILED",
            error: error instanceof Error ? error.message : String(error),
            telegramMessageId: messageId,
          }),
        );
        return false;
      }
    };

    if (reservation.status === "duplicate") {
      return {
        alreadySent: true,
        delivered: true,
        path: reservation.file.path,
        replayed: false,
        retryable: false,
        scope: reservation.file.scope,
        sideEffectStatus: "completed" as const,
        telegramMessageId: reservation.telegramMessageId,
      };
    }
    // A replayed step whose card went out: the process may have died before the journal, so the
    // projection is written again (the journal takes the same message once), as for a file.
    if (reservation.status === "completed") {
      return {
        alreadySent: false,
        delivered: true,
        path: reservation.file.path,
        projectionCompleted: await project(reservation.telegramMessageId),
        replayed: true,
        retryable: false,
        scope: reservation.file.scope,
        sideEffectStatus: "completed" as const,
        telegramMessageId: reservation.telegramMessageId,
      };
    }

    const html = reservation.bytes.toString("utf8");
    let size: ReturnType<typeof requireTelegramWidgetSize>;
    let lint: ReturnType<typeof lintTelegramWidget>;
    try {
      if (!/html/iu.test(reservation.file.mediaType) && !/\.html?$/iu.test(reservation.file.path)) {
        throw refused(
          "AGENT_TELEGRAM_WIDGET_NOT_HTML",
          `Файл ${reservation.file.path} не HTML (${reservation.file.mediaType})`,
          "Сохрани карточку в файл .html и передай его path.",
        );
      }
      try {
        size = requireTelegramWidgetSize(html);
      } catch (error) {
        throw refused(
          "AGENT_TELEGRAM_WIDGET_TOO_LARGE",
          error instanceof Error
            ? error.message.replace(/^AGENT_TELEGRAM_WIDGET_TOO_LARGE:\s*/u, "")
            : String(error),
          "Ужми карточку: убери вшитые картинки, повторяющиеся инлайн-стили замени классами, сократи строки и данные; затем отправь заново.",
        );
      }
      lint = lintTelegramWidget(html, { allowLinks: auth.groupType !== "external" });
      if (lint.errors.length > 0) {
        throw refused(
          "AGENT_TELEGRAM_WIDGET_INVALID",
          lint.errors.join("; "),
          "Исправь перечисленное в файле и отправь заново.",
        );
      }
    } catch (error) {
      await workspaceFileDeliveryRepository.fail(
        ctx.callId,
        error instanceof ModelFacingError ? error.code : "AGENT_TELEGRAM_WIDGET_INVALID",
      );
      throw error;
    }

    const unknownOutcome = (detail: string): AppError => {
      // The request may have reached Telegram: the row stays started, so a retry reports ambiguity.
      console.error(
        JSON.stringify({ code: "AGENT_TELEGRAM_WIDGET_SEND_UNKNOWN", error: detail.slice(0, 200) }),
      );
      return new AppError(
        "AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS",
        "Отправка виджета начата, но её результат не подтверждён. Проверьте чат перед новым запросом",
      );
    };
    let sent: Awaited<ReturnType<typeof sendTelegramWidget>>;
    try {
      sent = await sendTelegramWidget({
        caption: input.caption,
        chatId: target.chatId,
        html,
        messageThreadId:
          target.messageThreadId === undefined ? null : String(target.messageThreadId),
      });
    } catch (error) {
      throw unknownOutcome(error instanceof Error ? error.message : String(error));
    }
    if (!sent.ok && sent.ambiguous)
      throw unknownOutcome(`HTTP ${sent.status} ${telegramDescription(sent.body)}`);
    if (!sent.ok) {
      await workspaceFileDeliveryRepository.fail(ctx.callId, "AGENT_TELEGRAM_WIDGET_REJECTED");
      throw new ModelFacingError({
        category: "dependency",
        code: "AGENT_TELEGRAM_WIDGET_REJECTED",
        correction:
          "Если Telegram назвал ошибку разметки, исправь файл; иначе не повторяй и скажи, что карточка не отправилась.",
        reason: `Telegram отклонил виджет: HTTP ${sent.status}, ${telegramDescription(sent.body)}`,
        retryable: false,
        sideEffectStatus: "not_started",
      });
    }
    try {
      await workspaceFileDeliveryRepository.complete(ctx.callId, sent.messageId);
    } catch (error) {
      console.error(
        JSON.stringify({
          code: "AGENT_WORKSPACE_FILE_COMPLETION_FAILED",
          error: error instanceof Error ? error.message : String(error),
          telegramMessageId: sent.messageId,
        }),
      );
    }
    const projectionCompleted = await project(sent.messageId);
    console.info(
      JSON.stringify({
        bytes: size.bytes,
        code: "AGENT_TELEGRAM_WIDGET_SENT",
        compressedBytes: size.compressedBytes,
        links: lint.links.length,
        telegramMessageId: sent.messageId,
        warnings: lint.warnings.length,
      }),
    );
    return {
      alreadySent: false,
      caption_already_sent: isScheduledSession(ctx)
        ? SCHEDULED_CAPTION_SENT_NOTE
        : CAPTION_SENT_NOTE,
      delivered: true,
      links: lint.links,
      path: reservation.file.path,
      projectionCompleted,
      replayed: false,
      retryable: false,
      scope: reservation.file.scope,
      sideEffectStatus: "completed" as const,
      size,
      telegramMessageId: sent.messageId,
      warnings: lint.warnings,
    };
  },
});

/** In an external group: the group workspace only, and no links in the card. */
export const EXTERNAL_SEND_WIDGET_PRESENTATION = {
  description: [
    "Отправить в текущий чат или тему внешней группы виджет Telegram: карточку из HTML-файла group workspace.",
    "Виджет ожидается для сводок с числами, таблиц и сравнений; разговор, шутка и короткий ответ остаются текстом.",
    "Перед первым виджетом загрузи навык telegram-widgets. Карточка без ссылок: здесь любой адрес в ней считается ошибкой.",
    "Вход: path относительно group scope, например widgets/top.html, и caption, то есть итог карточки одной строкой. Результат delivered=true подтверждает отправку.",
  ].join(" "),
  inputSchema: z
    .object({
      caption: z.string().trim().min(1).max(1_024).describe("Короткий итог карточки одной строкой"),
      path: z
        .string()
        .min(1)
        .max(512)
        .describe("Относительный путь к .html внутри group workspace"),
      scope: z.literal("group").describe("Workspace текущей внешней группы"),
    })
    .strict(),
};
