/**
 * Filters for turn inputs of prompt evals.
 *
 * Exports:
 * - `isAddressedToMia`: whether the current message of a turn envelope names Mia.
 *
 * Key construct:
 * - The name check is the bot's own (`isAgentNameMentioned`), applied to the text of the current
 *   message only. The earlier regular expression ended in `\b`, which in JavaScript knows only
 *   Latin word characters, so after a Cyrillic name it never matched and `--addressed-only`
 *   dropped every turn (5 November 2026).
 */
import { isAgentNameMentioned } from "../../agent/lib/telegram-message-policy.js";

export function isAddressedToMia(envelope: string): boolean {
  const block = envelope.match(/<current_telegram_message>([\s\S]*?)<\/current_telegram_message>/u)?.[1]?.trim();
  if (!block) return false;
  let text = block;
  try {
    const parsed = JSON.parse(block) as { text?: unknown };
    if (typeof parsed.text === "string") text = parsed.text;
  } catch {
    // Not JSON: the block itself is the text.
  }
  return isAgentNameMentioned(text);
}
