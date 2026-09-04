/**
 * Telegram terminal failure notification privacy policy.
 *
 * Exports:
 * - `shouldNotifyTelegramFailure`: permits failure details only in a verified private chat.
 */
import type { TelegramEventContext } from "eve/channels/telegram";

import { MODEL_UNAVAILABLE_FAILURE_CODE } from "./telegram-interface.js";

const SHARED_CHAT_TYPES = new Set(["group", "supergroup"]);

export function shouldNotifyTelegramFailure(
  channel: Pick<TelegramEventContext, "state">,
  code?: string,
): boolean {
  if (channel.state.chatType === "private") return true;
  // Missing or shared chat metadata fails closed because terminal errors may expose internals.
  // A spent model call is the one exception: its message names an outage and nothing internal,
  // and without it a group only sees the agent going quiet.
  return code === MODEL_UNAVAILABLE_FAILURE_CODE &&
    SHARED_CHAT_TYPES.has(channel.state.chatType ?? "");
}
