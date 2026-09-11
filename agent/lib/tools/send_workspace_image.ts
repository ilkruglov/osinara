/**
 * Workspace-to-Telegram image sender tool.
 *
 * Export:
 * - Eve `send_workspace_image` tool delivering a workspace raster image as a Telegram photo.
 */
import { createWorkspaceSendTool } from "../attachments/workspace-send-tool.js";

export default createWorkspaceSendTool({
  description: [
    "Когда использовать: показать в текущем Telegram-чате или теме картинку, которая уже лежит в доступном workspace, в том числе только что нарисованную generate_image.",
    "Не использовать: не создаёт файл, не принимает абсолютный sandbox path и не отправляет не-картинки; для PDF, таблиц, текста и архивов есть send_workspace_file.",
    "Вход: path относительно корня выбранного scope; не добавляй personal, family или group в начало пути. Уходит фотографией, выбирать способ отправки не нужно.",
    "Ограничения Telegram: JPEG, PNG или WebP до 10 МБ; файл другого формата или крупнее отправляй через send_workspace_file документом.",
    "Результат: delivered=true, telegramMessageId, path, scope и replayed; alreadySent=true означает, что эти же байты уже ушли в этот чат на этом ходе и повторно ничего не отправлено.",
    "Ошибка: если sideEffectStatus=unknown или completed, не отправляй файл повторно без нового запроса пользователя.",
  ].join(" "),
  pathExample: "work/poster.png",
  presentation: "photo",
});
