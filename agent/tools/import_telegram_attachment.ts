/**
 * Lazy family Telegram attachment import tool.
 *
 * Export:
 * - Eve `import_telegram_attachment` tool that materializes one authorized journal reference.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { materializeTelegramAttachment } from "../lib/attachments/telegram-attachment-materializer.js";
import {
  requireInputRecord,
  requireOnlyFields,
  requiredUuid,
} from "../lib/tool-input-validation.js";
import { requireWorkspaceAuthorization } from "../lib/workspaces/workspace-context.js";

const INPUT_ERROR_CODE = "AGENT_TELEGRAM_ATTACHMENT_IMPORT_INPUT_INVALID";
const TOP_LEVEL_FIELDS = ["attachmentId"] as const;

export default defineTool({
  description: [
    "Скачать по требованию одно ранее полученное вложение семейной Telegram-группы в family workspace.",
    "Передай attachmentId только из <telegram_attachment_refs> или журнала текущей группы.",
    "После успешного импорта используй возвращённый path для чтения документа или анализа изображения.",
  ].join(" "),
  inputSchema: z.object({ attachmentId: z.string().optional() }).passthrough(),
  async execute(input, ctx) {
    const payload = requireInputRecord(
      input,
      "import_telegram_attachment",
      INPUT_ERROR_CODE,
    );
    requireOnlyFields(payload, TOP_LEVEL_FIELDS, "import_telegram_attachment", INPUT_ERROR_CODE);
    const attachmentId = requiredUuid(
      payload,
      "attachmentId",
      INPUT_ERROR_CODE,
      "ссылка на вложение из текущей семейной группы",
    );
    return await materializeTelegramAttachment(
      requireWorkspaceAuthorization(ctx),
      attachmentId,
    );
  },
});
