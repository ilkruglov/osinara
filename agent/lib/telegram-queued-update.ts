/**
 * A queued Telegram update as the application reads it.
 *
 * Export:
 * - `parseQueuedTelegramUpdate`: Eve's parse of a stored payload, with a Rich Message's blocks and
 *   a shared location turned into its text (Eve reads only `text`). The drain, its series, the
 *   summary of the queue and the messages shown during a turn all read this one form, so a new
 *   reader of the queue cannot skip the normalization (26 November 2026).
 */
import { parseTelegramUpdate, type TelegramUpdate } from "eve/channels/telegram";

import { withLocationText } from "./telegram-location-message.js";
import { normalizeRichMessage } from "./telegram-rich-message.js";

export function parseQueuedTelegramUpdate(payload: unknown): TelegramUpdate | null {
  const parsed = parseTelegramUpdate(payload);
  return parsed === null ? null : withLocationText(normalizeRichMessage(parsed));
}
