/**
 * Bot API calls of a whisper (Bot API ephemeral messages).
 *
 * Exports:
 * - `sendTelegramWhisperReply`: an ephemeral reply to the ephemeral command, for its author only;
 *   returns the reply's own ephemeral id for the later edit.
 * - `editTelegramWhisperMessage`: replaces an ephemeral message with plain or rich text.
 * - `deleteTelegramWhisperMessage`: removes an ephemeral message.
 *
 * Key constructs:
 * - A reply anchored to the command is allowed within 15 seconds of it; an edit or a removal of the
 *   bot's own ephemeral message has no such window.
 * - Every call goes through Eve's `callTelegramApi`: the pacing slot and the per-attempt deadline
 *   are the same as for every other send. Telegram's refusal is returned, never thrown.
 */
import { callTelegramApi } from "eve/channels/telegram";

export type TelegramWhisperContent = { readonly format: "plain" | "rich"; readonly text: string };

export type TelegramWhisperSendResult =
  { ok: true; placeholderMessageId: number } | { body: unknown; ok: false; status: number };

export type TelegramWhisperEditResult = { ok: true } | { body: unknown; ok: false; status: number };

interface ApiOptions {
  readonly botToken?: string;
  readonly fetch?: typeof fetch;
}

function chatIdValue(chatId: string): number | string {
  const numeric = Number(chatId);
  return Number.isSafeInteger(numeric) ? numeric : chatId;
}

function contentBody(content: TelegramWhisperContent): Record<string, unknown> {
  return content.format === "rich"
    ? { rich_message: { markdown: content.text } }
    : { text: content.text };
}

function apiOptions(options: ApiOptions) {
  return {
    ...(options.botToken === undefined ? {} : { botToken: options.botToken }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  };
}

function sentEphemeralId(body: unknown): number | null {
  const id = (body as { result?: { ephemeral_message_id?: unknown } } | null)?.result
    ?.ephemeral_message_id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function sendTelegramWhisperReply(
  input: ApiOptions & {
    chatId: string;
    ephemeralMessageId: number;
    messageThreadId: number | null;
    receiverUserId: string;
    text: string;
  },
): Promise<TelegramWhisperSendResult> {
  const response = await callTelegramApi({
    body: {
      chat_id: chatIdValue(input.chatId),
      ephemeral_message_parameters: { receiver_user_id: Number(input.receiverUserId) },
      ...(input.messageThreadId === null ? {} : { message_thread_id: input.messageThreadId }),
      reply_parameters: { ephemeral_message_id: input.ephemeralMessageId },
      text: input.text,
    },
    method: "sendMessage",
    ...apiOptions(input),
  });
  const placeholderMessageId = response.ok ? sentEphemeralId(response.body) : null;
  if (placeholderMessageId === null)
    return { body: response.body, ok: false, status: response.status };
  return { ok: true, placeholderMessageId };
}

export async function editTelegramWhisperMessage(
  input: ApiOptions & {
    chatId: string;
    content: TelegramWhisperContent;
    placeholderMessageId: number;
    receiverUserId: string;
  },
): Promise<TelegramWhisperEditResult> {
  const response = await callTelegramApi({
    body: {
      chat_id: chatIdValue(input.chatId),
      ephemeral_message_id: input.placeholderMessageId,
      receiver_user_id: Number(input.receiverUserId),
      ...contentBody(input.content),
    },
    method: "editEphemeralMessageText",
    ...apiOptions(input),
  });
  if (response.ok) return { ok: true };
  const description = (response.body as { description?: unknown } | null)?.description;
  if (typeof description === "string" && /message is not modified/iu.test(description))
    return { ok: true };
  return { body: response.body, ok: false, status: response.status };
}

export async function deleteTelegramWhisperMessage(
  input: ApiOptions & {
    chatId: string;
    placeholderMessageId: number;
    receiverUserId: string;
  },
): Promise<TelegramWhisperEditResult> {
  const response = await callTelegramApi({
    body: {
      chat_id: chatIdValue(input.chatId),
      ephemeral_message_id: input.placeholderMessageId,
      receiver_user_id: Number(input.receiverUserId),
    },
    method: "deleteEphemeralMessage",
    ...apiOptions(input),
  });
  return response.ok ? { ok: true } : { body: response.body, ok: false, status: response.status };
}
