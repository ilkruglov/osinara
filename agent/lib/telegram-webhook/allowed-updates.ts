/**
 * The update types the bot subscribes to, shared by the installer and the running agent.
 *
 * Export:
 * - `TELEGRAM_ALLOWED_UPDATES`: every update type the application handles.
 *
 * Telegram delivers only the types named in `allowed_updates`, and a `setWebhook` without the field keeps
 * the previous list (Bot API 10.3, `setWebhook`). A type the application handles but the list misses is
 * lost in silence, so the list lives in one place. `message_reaction` feeds turn evaluations
 * (`turn-quality/telegram-reaction-update.ts`); `my_chat_member` (the bot blocked or unblocked in a
 * private chat, removed from or added to a group) joined on 24 October 2026.
 */
export const TELEGRAM_ALLOWED_UPDATES = [
  "message",
  "callback_query",
  "message_reaction",
  "my_chat_member",
] as const;
