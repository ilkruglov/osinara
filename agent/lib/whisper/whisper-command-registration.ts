/**
 * Declaring `/whisper` to Telegram for all group chats.
 *
 * Export:
 * - `ensureTelegramWhisperCommand`: declares the ephemeral command when Telegram's list for all
 *   group chats lacks it or holds another version of it; other commands there are kept.
 *
 * Key construct:
 * - Only a command declared with `is_ephemeral` makes the client send it as an ephemeral message
 *   (Bot API ephemeral commands). The declaration lives in Telegram, not in the release, so the
 *   periodic webhook check (`schedules/telegram-webhook-subscription.ts`) also checks this list.
 */
import { callTelegramApi } from "eve/channels/telegram";

import { AppError } from "../app-error.js";
import { telegramProviderDescription } from "../telegram-reachability/recipient-failure.js";
import { TELEGRAM_WHISPER_BOT_COMMAND, TELEGRAM_WHISPER_COMMAND } from "./telegram-whisper.js";

const GROUP_CHATS_SCOPE = { type: "all_group_chats" } as const;

type BotCommand = {
  command: string;
  description: string;
  is_ephemeral?: boolean;
};

function commandFailure(stage: string, response: { body: unknown; status: number }): AppError {
  console.error(JSON.stringify({
    code: "AGENT_TELEGRAM_WHISPER_COMMAND_FAILED",
    providerDescription: telegramProviderDescription(response.body),
    providerStatus: response.status,
    stage,
  }));
  return new AppError("AGENT_TELEGRAM_WHISPER_COMMAND_FAILED", "Не удалось объявить Telegram команду /whisper");
}

function commandsOf(body: unknown): BotCommand[] | null {
  const result = (body as { result?: unknown } | null)?.result;
  if (!Array.isArray(result)) return null;
  return result.flatMap((item) => {
    const candidate = item as Partial<BotCommand> | null;
    if (typeof candidate?.command !== "string" || typeof candidate.description !== "string") return [];
    return [{
      command: candidate.command,
      description: candidate.description,
      ...(candidate.is_ephemeral === true ? { is_ephemeral: true } : {}),
    }];
  });
}

export async function ensureTelegramWhisperCommand(input: {
  botToken: string;
  fetch?: typeof fetch;
}): Promise<"unchanged" | "updated"> {
  const options = { botToken: input.botToken, ...(input.fetch === undefined ? {} : { fetch: input.fetch }) };
  const read = await callTelegramApi({ body: { scope: GROUP_CHATS_SCOPE }, method: "getMyCommands", ...options });
  const current = read.ok ? commandsOf(read.body) : null;
  if (current === null) throw commandFailure("read", read);
  const declared = current.find((command) => command.command === TELEGRAM_WHISPER_COMMAND);
  if (declared?.description === TELEGRAM_WHISPER_BOT_COMMAND.description && declared.is_ephemeral === true) {
    return "unchanged";
  }
  const commands = [
    ...current.filter((command) => command.command !== TELEGRAM_WHISPER_COMMAND),
    { ...TELEGRAM_WHISPER_BOT_COMMAND },
  ];
  const written = await callTelegramApi({ body: { commands, scope: GROUP_CHATS_SCOPE }, method: "setMyCommands", ...options });
  if (!written.ok) throw commandFailure("write", written);
  return "updated";
}
