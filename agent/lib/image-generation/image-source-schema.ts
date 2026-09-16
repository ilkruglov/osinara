/** Common model-facing image locations; execution still performs live workspace authorization. */
import { z } from "zod";

export function imageSourcesSchema(external = false) {
  return z.array(z.object({
    attachmentId: z.uuid().optional().describe("UUID исходника из telegram_attachment_refs или журнала группы"),
    path: z.string().min(1).max(512).optional().describe("Относительный путь существующего изображения в workspace"),
    scope: external ? z.literal("group") : z.enum(["personal", "family", "group"]),
    telegramMessageId: z.string().regex(/^\d+$/u).optional().describe("ID сообщения с фото в текущем Telegram-чате"),
  }).strict()).min(1).max(4).optional()
    .describe("Для правки передай исходники в порядке упоминания в prompt; в каждом ровно один attachmentId, path или telegramMessageId. Для новой картинки поле опусти. Правки поддерживает Cloudflare");
}
