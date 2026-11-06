/**
 * The switch for Telegram widgets (Bot API 10.4 beta).
 *
 * Export:
 * - `TELEGRAM_WIDGETS_ENABLED`: `TELEGRAM_WIDGETS_ENABLED=true` in the environment.
 *
 * The widget API is a beta Telegram may change. Off, the `send_widget` descriptor and the
 * `telegram-widgets` skill disappear together: a skill that teaches a tool the model does not have
 * makes it write the call as text.
 */
export const TELEGRAM_WIDGETS_ENABLED = process.env.TELEGRAM_WIDGETS_ENABLED === "true";
