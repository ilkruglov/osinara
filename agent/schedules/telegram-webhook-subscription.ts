/**
 * Eve check, every ten minutes, that Telegram sends the bot every update type it handles.
 *
 * Export:
 * - Default schedule; writes to Telegram only when `allowed_updates` of this installation's own webhook
 *   (`PUBLIC_BASE_URL` + `/eve/v1/telegram`) differs from the application's list, so the first tick after a
 *   deploy subscribes a running installation to a new type. `TELEGRAM_WEBHOOK_IP_ADDRESS`, when set, is
 *   sent as `ip_address`.
 * - The same tick declares the ephemeral `/whisper` for all group chats when Telegram lacks it.
 */
import { defineSchedule } from "eve/schedules";

import { ensureTelegramWebhookSubscription } from "../lib/telegram-webhook/webhook-subscription.js";
import { ensureTelegramWhisperCommand } from "../lib/whisper/whisper-command-registration.js";

export default defineSchedule({
  cron: "*/10 * * * *",
  run({ waitUntil }) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
    if (!botToken || !secretToken) return;
    waitUntil(
      ensureTelegramWebhookSubscription({
        botToken,
        ipAddress: process.env.TELEGRAM_WEBHOOK_IP_ADDRESS,
        publicBaseUrl: process.env.PUBLIC_BASE_URL,
        secretToken,
      })
        .then((outcome) => {
          if (outcome === "unchanged") return;
          const log = outcome === "updated" ? console.info : console.warn;
          log(JSON.stringify({ code: "AGENT_TELEGRAM_WEBHOOK_SUBSCRIPTION_CHECKED", outcome }));
        })
        .catch((error: unknown) => {
          console.error(
            JSON.stringify({
              code: "AGENT_TELEGRAM_WEBHOOK_SUBSCRIPTION_FAILED",
              errorCode: error instanceof Error && "code" in error ? String(error.code) : null,
              errorName: error instanceof Error ? error.name : "UnknownError",
            }),
          );
        }),
    );
    // The ephemeral `/whisper` exists for group members only once Telegram knows it; the failure
    // is logged by the check itself.
    waitUntil(
      ensureTelegramWhisperCommand({ botToken })
        .then((outcome) => {
          if (outcome === "updated")
            console.info(
              JSON.stringify({ code: "AGENT_TELEGRAM_WHISPER_COMMAND_CHECKED", outcome }),
            );
        })
        .catch(() => undefined),
    );
  },
});
