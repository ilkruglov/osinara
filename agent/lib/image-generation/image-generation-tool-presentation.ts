/**
 * External-group model presentation for subscription image generation.
 *
 * Export:
 * - `EXTERNAL_IMAGE_GENERATION_TOOL_PRESENTATION`: group-only description and input schema.
 *
 * Key construct:
 * - The series contract (`keep`, the refusal of an echo) is the same as in the main descriptor:
 *   a refusal that asks for `keep` must be answerable in every chat where the tool exists.
 */
import type { ToolDefinition } from "eve/tools";
import { z } from "zod";
import { imageSourcesSchema } from "./image-source-schema.js";

type AnyToolDefinition = ToolDefinition<any, any>;

const IMAGE_PROMPT_MAX_LENGTH = 8_000;
export const IMAGE_KEEP_MAX_ITEMS = 10;
export const IMAGE_KEEP_ITEM_MAX_LENGTH = 120;

/** What the user asked to keep from earlier pictures of the series; the series check tolerates it. */
export const imageKeepSchema = () => z.array(z.string().min(1).max(IMAGE_KEEP_ITEM_MAX_LENGTH)).max(IMAGE_KEEP_MAX_ITEMS).optional()
  .describe("Что из прошлых картинок этой серии сохраняется по просьбе пользователя: стиль, палитра, герой, сюжет, своими словами. Пусто для первой картинки и для правки существующей.");

export const IMAGE_SERIES_RULE =
  "Серия вариантов: каждый новый prompt пиши с чистого листа по текущей просьбе, а не по своим прошлым prompt; герой, предметы в его руках, палитра и приёмы прошлых вариантов в новый не переходят сами. Инструмент сравнивает prompt с прошлыми картинками этой серии и отказывает, если он повторяет их элементы, которых нет в keep. В keep перечисли то, что пользователь просил сохранить (стиль, палитру, героя, сюжет); для первой картинки и для правки существующей оставь его пустым.";

export const EXTERNAL_IMAGE_GENERATION_TOOL_PRESENTATION: Pick<
  AnyToolDefinition,
  "description" | "inputSchema"
> = {
  description: [
    "Создать одно raster-изображение и сохранить его в group workspace. В чат оно само не уходит: покажи его вызовом send_workspace_image с возвращённым path.",
    "В prompt опиши назначение, сцену, объект, композицию, стиль и запреты. Для unspecified size, quality или background передай auto.",
    "Для правки передай images с исходниками из текущей группы, а в prompt укажи изменения и что сохранить. Результат правки сохраняется новым файлом.",
    "Не используй для SVG, code-native диаграмм или фоновой генерации.",
    "Если ошибка сообщает unknown status, не повторяй вызов автоматически: лимит подписки мог быть списан.",
    IMAGE_SERIES_RULE,
  ].join(" "),
  inputSchema: z.object({
    images: imageSourcesSchema(true),
    background: z.enum(["transparent", "opaque", "auto"]),
    keep: imageKeepSchema(),
    prompt: z.string().min(1).max(IMAGE_PROMPT_MAX_LENGTH),
    quality: z.enum(["low", "medium", "high", "auto"]),
    size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]),
  }).strict(),
};
