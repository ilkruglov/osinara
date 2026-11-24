/** Common model-facing image locations; execution still performs live workspace authorization. */
import { z } from "zod";

/** Sources of one picture, avatars included: Seedream 5.5 edit takes ten and drops the rest silently. */
export const IMAGE_SOURCES_MAX = 10;

export function imageSourcesSchema(external = false) {
  return z
    .array(
      z
        .object({
          attachmentId: z
            .uuid()
            .optional()
            .describe("UUID исходника из telegram_attachment_refs или журнала группы"),
          path: z
            .string()
            .min(1)
            .max(512)
            .optional()
            .describe("Относительный путь существующего изображения в workspace"),
          scope: external ? z.literal("group") : z.enum(["personal", "family", "group"]),
          telegramMessageId: z
            .string()
            .regex(/^\d+$/u)
            .optional()
            .describe("ID сообщения с фото в текущем Telegram-чате"),
        })
        .strict(),
    )
    .min(1)
    .max(IMAGE_SOURCES_MAX)
    .optional()
    .describe(
      "Исходники в порядке упоминания в prompt; в каждом ровно один attachmentId, path или telegramMessageId. Без исходников поле опусти",
    );
}
