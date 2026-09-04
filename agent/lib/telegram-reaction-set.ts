/**
 * Reaction set a Telegram chat accepts.
 *
 * Exports:
 * - `TELEGRAM_DEFAULT_REACTIONS`: the set Telegram accepts where a chat adds no restriction.
 * - `resolveChatReactions`: the set of the current chat, or `null` when it has none.
 *
 * Key construct:
 * - Bot API exposes a chat's list only when an administrator narrowed it; the unrestricted answer
 *   names no symbols at all. The default set below is that missing half, kept in sync with
 *   `isTelegramMessageReactionEmoji` so the agent can never pick a value this app would reject.
 */
import type { TelegramReactionPolicy } from "./telegram-reaction-policy.js";

export const TELEGRAM_DEFAULT_REACTIONS: readonly string[] = [
  "❤️", "👍", "👎", "🔥", "🥰", "👏", "😁", "🤔",
  "💩", "🤮", "🤩", "🎉", "😢", "🤬", "😱", "🤯",
  "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳",
  "🏆", "🍌", "⚡️", "🤣", "💯", "🌭", "🌚", "❤️‍🔥",
  "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈",
  "🙈", "🎃", "👀", "👨‍💻", "👻", "🤓", "😭", "😴",
  "😇", "😨", "🤝", "✍️", "🤗", "🫡", "🎅", "🎄",
  "🦄", "🙉", "💘", "🆒", "🗿", "🤪", "💅", "☃️",
  "😘", "💊", "🙊", "😎", "👾", "🤷‍♂️", "🤷", "🤷‍♀️",
  "😡",
];

export function resolveChatReactions(
  policy: TelegramReactionPolicy | null,
): readonly string[] | null {
  if (policy === null) return null;
  if (policy.allowsAll) return TELEGRAM_DEFAULT_REACTIONS;
  // An empty explicit list is a chat with reactions turned off, not an unknown policy.
  return policy.emoji.length > 0 ? policy.emoji : null;
}
