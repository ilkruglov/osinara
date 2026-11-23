/**
 * A file's caption on its way to Telegram.
 *
 * Export:
 * - `telegramCaptionSchema`: the tools' caption input, bounded by what Telegram shows of it.
 *
 * Key construct:
 * - Telegram limits a caption to 1 024 characters after it parses the entities. Counting the HTML
 *   refused captions well under the limit (an `&` becomes `&amp;`, a link carries its address) and
 *   reported the refusal as an unknown outcome after the send was reserved (final review,
 *   22 November 2026); the schema refuses before anything is reserved, as an input the model can
 *   shorten. Delivery renders the same Markdown with `renderTelegramMarkdownHtml`.
 */
import { z } from "zod";

import { decodeHtmlEntities } from "../html-text.js";
import { renderTelegramMarkdownHtml } from "../telegram-markdown.js";

const TELEGRAM_CAPTION_MAX_CHARACTERS = 1_024;
/** A Markdown source may run longer than it shows (link addresses); this bounds the work only. */
const CAPTION_SOURCE_MAX_CHARACTERS = 4_096;

/** What Telegram counts of a caption: the rendered text without its tags, entities decoded. */
function visibleLength(markdown: string): number {
  return decodeHtmlEntities(renderTelegramMarkdownHtml(markdown).replace(/<[^>]*>/gu, "")).length;
}

export const telegramCaptionSchema = z
  .string()
  // `abort`: zod would run the refinement below even after this bound failed (4 s on 65 536).
  .max(CAPTION_SOURCE_MAX_CHARACTERS, { abort: true })
  .refine((caption) => visibleLength(caption) <= TELEGRAM_CAPTION_MAX_CHARACTERS, {
    message:
      "Подпись длиннее 1024 видимых символов: сократите её или отправьте текст отдельным сообщением",
  })
  .describe(
    "Необязательная подпись Telegram, до 1024 видимых символов. Это Markdown: **…** станет жирным, _…_ курсивом.",
  );
