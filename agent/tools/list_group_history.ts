/**
 * Eve tool for the current verified Telegram group timeline.
 *
 * Export:
 * - `list_group_history`: bounded pagination and search without a model-selectable group scope.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { searchTelegramGroupHistory } from "../lib/telegram-group-history.js";
import { telegramGroupJournalRepository } from "../lib/telegram-group-journal-repository.js";

const POSITIVE_BIGINT = z.string().regex(/^[1-9]\d*$/u);

export default defineTool({
  description: [
    "Найти сообщения в единой истории всей текущей Telegram-группы, включая другие форумные темы.",
    "Область группы определяется только проверенной авторизацией; sequence IDs вида #42 подходят для адресной пагинации.",
    "participant принимает точный username без @; ответы содержат только безопасные sequence IDs.",
  ].join(" "),
  inputSchema: z.object({
    beforeSequence: POSITIVE_BIGINT.optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    participant: z.string().trim().min(1).max(200).optional(),
    query: z.string().trim().min(1).max(500).optional(),
    sequenceFrom: POSITIVE_BIGINT.optional(),
    sequenceTo: POSITIVE_BIGINT.optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  }).strict(),
  async execute(input, ctx) {
    return await searchTelegramGroupHistory(telegramGroupJournalRepository, input, ctx);
  },
});
