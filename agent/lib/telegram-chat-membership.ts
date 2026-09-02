/**
 * Live Telegram chat presence of one user.
 *
 * Exports:
 * - `TelegramChatPresence`: whether Telegram still counts the user as part of the chat.
 * - `TelegramChatPresenceLookup`: injectable contract used by application boundaries.
 * - `telegramChatMemberPresence`: verified `getChatMember` answer for one chat and user.
 *
 * Key construct:
 * - Presence decides whether another participant may remove a reminder left behind by its author,
 *   so an unusable answer must stay unknown. Reading a failure as absence would let anyone delete a
 *   present author's reminder by making the lookup fail.
 */
import { callTelegramApi } from "eve/channels/telegram";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../config.js";
import { AppError } from "./app-error.js";

export type TelegramChatPresence = "absent" | "present";

export type TelegramChatPresenceLookup = (input: {
  telegramChatId: string;
  telegramUserId: string;
}) => Promise<TelegramChatPresence>;

const TELEGRAM_USER_ID_PATTERN = /^[1-9]\d*$/u;
const PRESENT_STATUSES = new Set(["administrator", "creator", "member"]);
const ABSENT_STATUSES = new Set(["kicked", "left"]);

function requireTelegramBotToken(): string {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new AppError(
      "AGENT_TELEGRAM_PRESENCE_CONFIG_MISSING",
      "Не задан Telegram bot token для проверки участия в чате",
    );
  }
  return botToken;
}

function presenceUnknown(reason: string): AppError {
  console.error(JSON.stringify({ code: "AGENT_TELEGRAM_CHAT_PRESENCE_UNKNOWN", reason }));
  return new AppError(
    "AGENT_TELEGRAM_CHAT_PRESENCE_UNKNOWN",
    "Не удалось проверить, остался ли этот человек в чате. Попробуйте повторить позже",
  );
}

export const telegramChatMemberPresence: TelegramChatPresenceLookup = async (input) => {
  if (
    !TELEGRAM_USER_ID_PATTERN.test(input.telegramUserId) ||
    !Number.isSafeInteger(Number(input.telegramUserId))
  ) {
    throw new AppError(
      "AGENT_TELEGRAM_CHAT_PRESENCE_TARGET_INVALID",
      "Не удалось определить человека, чьё участие в чате нужно проверить",
    );
  }

  // The token is resolved before the call, so a missing secret fails as configuration instead of
  // being translated into the retryable presence-unknown answer below.
  const botToken = requireTelegramBotToken();
  const signal = AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await callTelegramApi({
      body: { chat_id: input.telegramChatId, user_id: Number(input.telegramUserId) },
      botToken,
      fetch: (request, init) => fetch(request, { ...init, signal }),
      method: "getChatMember",
    });
  } catch (error) {
    throw presenceUnknown(error instanceof Error ? error.name : "UnknownError");
  }

  const body = response.body as { ok?: unknown; result?: unknown } | null;
  if (!response.ok || body?.ok !== true) throw presenceUnknown(`status_${response.status}`);

  const member = body.result as { is_member?: unknown; status?: unknown } | null;
  const status = member?.status;
  if (typeof status !== "string") throw presenceUnknown("status_missing");
  if (PRESENT_STATUSES.has(status)) return "present";
  if (ABSENT_STATUSES.has(status)) return "absent";
  // Bot API: a restricted member reports its membership separately, because a restriction can be
  // applied both to someone still in the chat and to someone who already left it.
  if (status === "restricted" && typeof member?.is_member === "boolean") {
    return member.is_member ? "present" : "absent";
  }
  throw presenceUnknown(`status_unrecognized_${status}`);
};
