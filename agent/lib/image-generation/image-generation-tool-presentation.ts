/**
 * External-group model presentation for subscription image generation.
 *
 * Export:
 * - `EXTERNAL_IMAGE_GENERATION_TOOL_PRESENTATION`: group-only description and input schema.
 */
import type { ToolDefinition } from "eve/tools";
import { z } from "zod";
import { imageSourcesSchema } from "./image-source-schema.js";

type AnyToolDefinition = ToolDefinition<any, any>;

const IMAGE_PROMPT_MAX_LENGTH = 8_000;

export const EXTERNAL_IMAGE_GENERATION_TOOL_PRESENTATION: Pick<
  AnyToolDefinition,
  "description" | "inputSchema"
> = {
  description: [
    "Создать одно raster-изображение (Flux или GPT-Image) и сохранить его в group workspace. В чат оно само не уходит: покажи его вызовом send_workspace_image с возвращённым path.",
    "В prompt опиши назначение, сцену, объект, композицию, стиль и запреты. Для unspecified size, quality или background передай auto.",
    "Для правки передай images с исходниками из текущей группы, а в prompt укажи изменения и что сохранить. Правки доступны через Cloudflare, результат сохраняется новым файлом.",
    "Не используй для SVG, code-native диаграмм или фоновой генерации.",
    "Если ошибка сообщает unknown status, не повторяй вызов автоматически: лимит подписки мог быть списан.",
  ].join(" "),
  inputSchema: z.object({
    images: imageSourcesSchema(true),
    background: z.enum(["transparent", "opaque", "auto"]),
    prompt: z.string().min(1).max(IMAGE_PROMPT_MAX_LENGTH),
    quality: z.enum(["low", "medium", "high", "auto"]),
    size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]),
  }).strict(),
};
