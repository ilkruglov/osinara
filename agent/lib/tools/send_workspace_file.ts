/**
 * Workspace-to-Telegram document sender tool.
 *
 * Export:
 * - Eve `send_workspace_file` tool delivering a workspace file as a Telegram document.
 */
import { createWorkspaceSendTool } from "../attachments/workspace-send-tool.js";

export default createWorkspaceSendTool({
  description: [
    "Когда использовать: отправить уже существующий файл из доступного workspace в текущий Telegram-чат или тему документом, с сохранением исходного качества и имени.",
    "Не использовать: не создаёт файл и не принимает абсолютный sandbox path; чтобы показать картинку в ленте, есть send_workspace_image.",
    "Вход: path относительно корня выбранного scope; не добавляй personal, family или group в начало пути. Уходит документом, выбирать способ отправки не нужно.",
    "Результат: delivered=true, telegramMessageId, path, scope и replayed; alreadySent=true означает, что эти же байты уже ушли в этот чат на этом ходе и повторно ничего не отправлено; persistenceCompleted=false или projectionCompleted=false означает, что файл уже отправлен, но служебный учёт обновился не полностью.",
    "Ошибка: если sideEffectStatus=unknown или completed, не отправляй файл повторно без нового запроса пользователя.",
  ].join(" "),
  pathExample: "reports/result.pdf",
  presentation: "document",
});
