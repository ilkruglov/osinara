/**
 * Sending a Telegram widget message through the beta Bot API.
 *
 * Exports:
 * - `TELEGRAM_WIDGET_API_BASE_URL`: the beta endpoint that knows `sendWidget` (Bot API 10.4 beta).
 * - `sendTelegramWidget`: one widget to a chat or topic; the message id, or Telegram's answer for
 *   the caller to classify: a refusal (an unreachable chat, a rejected widget) or an ambiguous one.
 * - `editTelegramWidgetData`: the widget's per-message state (`chat_data`, up to 1024 bytes); the
 *   card redraws itself, silently. A state Telegram already has is not an error.
 *
 * Key constructs:
 * - The widget is a self-contained HTML card that Telegram renders in the chat; the HTML cannot be
 *   edited after sending. Widgets sent here ask nothing of the bot (`allow_queries: false`): their
 *   buttons work inside the card only.
 * - The call goes through Eve's `callTelegramApi`, so it waits for its pacing slot and keeps the
 *   per-attempt deadline like every other send. The beta endpoint has its own update subscription,
 *   separate from the production webhook (checked on 6 November 2026), so sending touches neither.
 * - The size is checked before the request: Telegram would refuse it anyway, with less to go on.
 */
import { callTelegramApi } from "eve/channels/telegram";

import { requireTelegramWidgetSize } from "./telegram-widget-limits.js";

export const TELEGRAM_WIDGET_API_BASE_URL = "https://api.telegram.org/beta";

/**
 * `ambiguous`: Telegram answered neither with the message nor with a refusal (a server error, a
 * success without the message id), so the card may be in the chat; a caller must not send it again.
 */
export type TelegramWidgetSendResult =
  | { messageId: string; ok: true }
  | { ambiguous: boolean; body: unknown; ok: false; status: number };

export async function sendTelegramWidget(input: {
  botToken?: string;
  caption?: string;
  chatId: string;
  fetch?: typeof fetch;
  html: string;
  messageThreadId?: string | null;
}): Promise<TelegramWidgetSendResult> {
  requireTelegramWidgetSize(input.html);
  const caption = input.caption?.trim();
  const response = await callTelegramApi({
    apiBaseUrl: TELEGRAM_WIDGET_API_BASE_URL,
    body: {
      allow_queries: false,
      ...(caption ? { caption } : {}),
      chat_id: input.chatId,
      height: 0,
      html: input.html,
      is_shared: false,
      ...(input.messageThreadId ? { message_thread_id: Number(input.messageThreadId) } : {}),
      width: 0,
    },
    ...(input.botToken === undefined ? {} : { botToken: input.botToken }),
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    method: "sendWidget",
  });
  if (!response.ok) return { ambiguous: response.status >= 500, body: response.body, ok: false, status: response.status };
  const result = (response.body as { result?: { message_id?: unknown } } | null)?.result;
  const messageId = result?.message_id;
  if (typeof messageId !== "number" && typeof messageId !== "string") {
    return { ambiguous: true, body: response.body, ok: false, status: response.status };
  }
  return { messageId: String(messageId), ok: true };
}

export type TelegramWidgetEditResult = { ok: true } | { body: unknown; ok: false; status: number };

export async function editTelegramWidgetData(input: {
  botToken?: string;
  chatData: string;
  chatId: string;
  fetch?: typeof fetch;
  messageId: string;
}): Promise<TelegramWidgetEditResult> {
  const response = await callTelegramApi({
    apiBaseUrl: TELEGRAM_WIDGET_API_BASE_URL,
    body: { chat_data: input.chatData, chat_id: input.chatId, message_id: Number(input.messageId) },
    ...(input.botToken === undefined ? {} : { botToken: input.botToken }),
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    method: "editMessageWidgetData",
  });
  if (response.ok) return { ok: true };
  const description = (response.body as { description?: unknown } | null)?.description;
  if (typeof description === "string" && /message is not modified/iu.test(description)) return { ok: true };
  return { body: response.body, ok: false, status: response.status };
}
