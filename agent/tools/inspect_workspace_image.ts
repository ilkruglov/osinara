/**
 * Persistent workspace image inspection tool.
 *
 * Export:
 * - Eve `inspect_workspace_image` tool over a path, Telegram inbox, or opaque journal reference.
 *
 * Key constructs:
 * - Object-shaped model schema avoids root anyOf in Eve descriptors.
 * - Input validation enforces exactly one image source before workspace authorization.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireWorkspaceAuthorization } from "../lib/workspaces/workspace-context.js";
import { inspectWorkspaceImage } from "../lib/workspaces/workspace-image-inspection.js";
import {
  requireInputRecord,
  requireOnlyFields,
  requiredEnum,
  requiredString,
  requiredUuid,
  toolInputError,
} from "../lib/tool-input-validation.js";

const INPUT_ERROR_CODE = "AGENT_WORKSPACE_IMAGE_INPUT_INVALID";
const SCOPES = ["personal", "family", "group"] as const;
const TOP_LEVEL_FIELDS = ["attachmentId", "path", "question", "scope", "telegramMessageId"] as const;
const TELEGRAM_MESSAGE_ID_PATTERN = /^\d+$/u;

const inspectWorkspaceImageSchema = z.object({
  attachmentId: z.string().optional(),
  path: z.string().optional(),
  question: z.string().optional(),
  scope: z.string().optional(),
  telegramMessageId: z.string().optional(),
}).passthrough();

function requireImageInput(input: Record<string, unknown>) {
  requireOnlyFields(input, TOP_LEVEL_FIELDS, "inspect_workspace_image", INPUT_ERROR_CODE);
  const path = input.path;
  const attachmentId = input.attachmentId;
  const telegramMessageId = input.telegramMessageId;
  const hasPath = path !== undefined;
  const hasTelegramMessageId = telegramMessageId !== undefined;
  const sourceCount = [attachmentId, path, telegramMessageId].filter((value) => value !== undefined).length;
  if (sourceCount !== 1) {
    toolInputError(
      INPUT_ERROR_CODE,
      "Для inspect_workspace_image передайте ровно один источник: attachmentId, path или telegramMessageId",
    );
  }
  const common = {
    question: requiredString(input, "question", INPUT_ERROR_CODE, "Что изображено?", { maxLength: 4_000 }),
    scope: requiredEnum(input, "scope", SCOPES, INPUT_ERROR_CODE),
  };
  if (attachmentId !== undefined) {
    return {
      ...common,
      attachmentId: requiredUuid(input, "attachmentId", INPUT_ERROR_CODE, "attachmentId"),
    };
  }
  if (hasPath) {
    return {
      ...common,
      path: requiredString(input, "path", INPUT_ERROR_CODE, "personal/photos/image.png", { maxLength: 512 }),
    };
  }
  const messageId = requiredString(input, "telegramMessageId", INPUT_ERROR_CODE, "773");
  if (!TELEGRAM_MESSAGE_ID_PATTERN.test(messageId)) {
    toolInputError(INPUT_ERROR_CODE, "telegramMessageId должен быть строкой с числовым ID сообщения Telegram, например \"773\"");
  }
  return { ...common, telegramMessageId: messageId };
}

const TOOL_DESCRIPTION = [
  "Открыть изображение из workspace либо Telegram по безопасной ссылке и ответить через vision-модель.",
  "Для изображения в reply ancestry или <telegram_attachment_refs> передавай attachmentId: анализ скачивает bytes только в память и не сохраняет файл.",
  "Для изображения из текущего Telegram-вложения используй payload {\"telegramMessageId\":\"773\",\"scope\":\"personal\",\"question\":\"Что изображено?\"}; не копируй длинный untrusted filename.",
  "Для уже известного файла используй payload {\"path\":\"personal/photos/image.png\",\"scope\":\"personal\",\"question\":\"Что изображено?\"}. Передавай ровно один источник.",
].join(" ");

export default defineTool({
  description: TOOL_DESCRIPTION,
  inputSchema: inspectWorkspaceImageSchema,
  async execute(input, ctx) {
    const payload = requireImageInput(requireInputRecord(input, "inspect_workspace_image", INPUT_ERROR_CODE));
    return await inspectWorkspaceImage(requireWorkspaceAuthorization(ctx), {
      ...payload,
      abortSignal: ctx.abortSignal,
    });
  },
});
