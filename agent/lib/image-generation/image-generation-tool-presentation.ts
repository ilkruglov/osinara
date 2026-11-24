/**
 * External-group model presentation for image generation.
 *
 * Exports:
 * - `EXTERNAL_IMAGE_GENERATION_TOOL_PRESENTATION`: group-only description and input schema.
 * - `IMAGE_PROMPT_RULE`, `IMAGE_SOURCES_RULE`, `IMAGE_AUTO_RULE`, `IMAGE_UNKNOWN_STATUS_RULE`: the
 *   sentences both descriptors share.
 *
 * Key construct:
 * - What both descriptors say about the prompt, the provider and the contract is written once: the
 *   prompt, the sources, `quality` and an unknown outcome. Two hand-kept copies drifted apart.
 */
import type { ToolDefinition } from "eve/tools";
import { z } from "zod";
import { IMAGE_SOURCES_MAX, imageSourcesSchema } from "./image-source-schema.js";

type AnyToolDefinition = ToolDefinition<any, any>;

const IMAGE_PROMPT_MAX_LENGTH = 8_000;

export const IMAGE_PROMPT_RULE =
  "Prompt пиши на английском по навыку imagegen: сцена, объект, детали, композиция, стиль, свет, точный текст и запреты; каждая надпись в картинке дана в нём дословно в кавычках (русская остаётся русской), любой другой видимый текст на новой картинке запрещён.";

export const IMAGE_SOURCES_RULE = `Исходник в images это картинка для правки (тогда в prompt изменение и поимённо всё, что сохранить) или референс для новой картинки (аватарка, фото предмета, образец стиля; тогда в prompt роль каждого). До ${IMAGE_SOURCES_MAX} исходников; они уменьшаются до 1536 px по длинной стороне, а при size auto пропорции обычно следуют исходнику.`;

export const IMAGE_AUTO_RULE =
  "Size и background, которых пользователь не назвал, передай auto; quality всегда auto: качество задаёт сервер.";

export const IMAGE_UNKNOWN_STATUS_RULE =
  "Если ошибка сообщает unknown status, не повторяй вызов автоматически: картинка могла быть уже оплачена.";

export const EXTERNAL_IMAGE_GENERATION_TOOL_PRESENTATION: Pick<
  AnyToolDefinition,
  "description" | "inputSchema"
> = {
  description: [
    "Создать одно raster-изображение и сохранить его в group workspace. В чат оно само не уходит: покажи его вызовом send_workspace_image с возвращённым path.",
    IMAGE_PROMPT_RULE,
    IMAGE_AUTO_RULE,
    "Исходники для images бери только из текущей группы.",
    IMAGE_SOURCES_RULE,
    "Результат правки сохраняется новым файлом.",
    "Не используй для SVG, code-native диаграмм или незапрошенной фоновой генерации.",
    IMAGE_UNKNOWN_STATUS_RULE,
    // inspect_workspace_image is a grant of its own here; the sender comes with the drawing grant.
    "Надписи, особенно кириллицу, модели иногда искажают: важную надпись продублируй в caption при отправке через send_workspace_image.",
  ].join(" "),
  inputSchema: z
    .object({
      images: imageSourcesSchema(true),
      background: z.enum(["transparent", "opaque", "auto"]),
      prompt: z.string().min(1).max(IMAGE_PROMPT_MAX_LENGTH),
      quality: z.enum(["low", "medium", "high", "auto"]),
      size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]),
    })
    .strict(),
};
