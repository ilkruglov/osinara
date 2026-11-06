/**
 * Telegram personal memory export delivery boundary.
 *
 * Export:
 * - `deliverMemoryExportFiles`: atomically sends JSON and Markdown as one media group.
 */
import { resolveTelegramBotToken } from "eve/channels/telegram";

import { AppError } from "./app-error.js";
import { postTelegramMultipart } from "./telegram-multipart-send.js";

const TELEGRAM_EXPORT_TIMEOUT_MILLISECONDS = 30_000;

export async function deliverMemoryExportFiles(
  input: { chatId: string; json: string; markdown: string },
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  const token = await resolveTelegramBotToken();
  const form = new FormData();
  form.set("chat_id", input.chatId);
  form.set("media", JSON.stringify([
    {
      caption: "Экспорт личной памяти Osinara",
      media: "attach://memory_json",
      type: "document",
    },
    { media: "attach://memory_markdown", type: "document" },
  ]));
  form.set(
    "memory_json",
    new Blob([input.json], { type: "application/json;charset=utf-8" }),
    "osinara-memory.json",
  );
  form.set(
    "memory_markdown",
    new Blob([input.markdown], { type: "text/markdown;charset=utf-8" }),
    "osinara-memory.md",
  );
  let response: Response;
  try {
    // The same Telegram limits as every message of the channel, 429 included.
    response = await postTelegramMultipart({
      chatId: input.chatId,
      fetch: fetchImplementation,
      form,
      method: "sendMediaGroup",
      timeoutMs: TELEGRAM_EXPORT_TIMEOUT_MILLISECONDS,
      token,
    });
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_MEMORY_EXPORT_DELIVERY_AMBIGUOUS",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    throw new AppError(
      "AGENT_MEMORY_EXPORT_DELIVERY_AMBIGUOUS",
      "Не удалось подтвердить доставку экспорта. Проверьте документы в чате перед новым запросом",
    );
  }
  if (!response.ok) {
    console.error(JSON.stringify({
      code: "AGENT_MEMORY_EXPORT_DELIVERY_FAILED",
      providerStatus: response.status,
    }));
    throw new AppError(
      "AGENT_MEMORY_EXPORT_DELIVERY_FAILED",
      "Не удалось отправить файлы экспорта. Повторите запрос позже",
    );
  }
}
