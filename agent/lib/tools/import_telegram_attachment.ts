/**
 * Lazy registered-group Telegram attachment import tool.
 *
 * Export:
 * - Eve `import_telegram_attachment` materializes one authorized family or external journal reference.
 * - External imports expose the canonical sandbox path accepted by guarded file tools.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { materializeTelegramAttachment } from "../attachments/telegram-attachment-materializer.js";
import {
  requireInputRecord,
  requireOnlyFields,
  requiredUuid,
} from "../tool-input-validation.js";
import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";

const INPUT_ERROR_CODE = "AGENT_TELEGRAM_ATTACHMENT_IMPORT_INPUT_INVALID";
const TOP_LEVEL_FIELDS = ["attachmentId"] as const;
const EXTERNAL_GROUP_SANDBOX_ROOT = "/workspace/group";

export default defineTool({
  description: [
    "Скачать по требованию одно разрешённое вложение зарегистрированной Telegram-группы в её workspace.",
    "Передай attachmentId только из <telegram_attachment_refs> или журнала текущей группы.",
    "После успешного импорта используй возвращённый path для чтения документа или анализа изображения.",
  ].join(" "),
  inputSchema: z.object({
    attachmentId: z.uuid().describe("Обязательный UUID вложения из <telegram_attachment_refs> или журнала текущей группы"),
  }).strict(),
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
      "ссылка на вложение из текущей зарегистрированной группы",
    );
    const authorization = requireWorkspaceAuthorization(ctx);
    const attachment = await materializeTelegramAttachment(authorization, attachmentId);

    // Restricted file wrappers require an absolute path under the exact group mount.
    if (authorization.groupType === "external") {
      return {
        ...attachment,
        path: `${EXTERNAL_GROUP_SANDBOX_ROOT}/${attachment.path}`,
      };
    }

    return attachment;
  },
});
