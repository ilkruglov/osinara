/**
 * Brings the update list of a running installation up to what the application handles.
 *
 * Exports:
 * - `TelegramWebhookSubscriptionOutcome`: what the check did.
 * - `ensureTelegramWebhookSubscription`: compares `allowed_updates` with `TELEGRAM_ALLOWED_UPDATES`
 *   and, when they differ, repeats `setWebhook` for this installation's own webhook URL.
 *
 * Key constructs:
 * - `setWebhook` used to run only in the installer, so an installation set up before a new update type
 *   would never receive it: `my_chat_member` would reach no running bot until its owner ran the
 *   installer again. The agent holds the same token and webhook secret, so it now fixes the list itself.
 * - The webhook is ours only when Telegram reports exactly the URL this installation registers
 *   (`PUBLIC_BASE_URL` + `/eve/v1/telegram`, `webhook-target.ts`): a foreign host with the same path
 *   must never receive our `secret_token`. Without a valid `PUBLIC_BASE_URL` nothing is changed
 *   (`expected_url_unknown`). No URL (no webhook at all), another URL, or a custom certificate the
 *   agent does not hold and a new `setWebhook` would drop, is left alone as well.
 * - Nothing but the list changes: the secret is the one the agent verifies every update against,
 *   `max_connections` is carried over, pending updates are kept.
 * - `ip_address` is sent only from the explicit `TELEGRAM_WEBHOOK_IP_ADDRESS`, exactly as the installer
 *   sends it. Without the setting the field is absent and Telegram resolves the host through DNS; an IP
 *   fixed by hand outside the setting is not supported and would be dropped by this call.
 */
import { callTelegramApi } from "eve/channels/telegram";

import { AppError } from "../app-error.js";
import { TELEGRAM_ALLOWED_UPDATES } from "./allowed-updates.js";
import {
  boundedTelegramFetch,
  readTelegramWebhookInfo,
  type TelegramWebhookCallOptions,
  type TelegramWebhookInfo,
} from "./webhook-info.js";
import { expectedTelegramWebhookUrl, sameTelegramWebhookUrl, telegramWebhookIpAddress } from "./webhook-target.js";

export type TelegramWebhookSubscriptionOutcome =
  | "custom_certificate"
  | "expected_url_unknown"
  | "foreign_url"
  | "no_webhook"
  | "unchanged"
  | "updated";

const SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;

function sameUpdates(current: readonly string[] | null): boolean {
  if (current === null || current.length !== TELEGRAM_ALLOWED_UPDATES.length) return false;
  const wanted = new Set<string>(TELEGRAM_ALLOWED_UPDATES);
  return current.every((type) => wanted.has(type)) && new Set(current).size === wanted.size;
}

function ownWebhook(info: TelegramWebhookInfo, expectedUrl: string): TelegramWebhookSubscriptionOutcome | null {
  if (info.url === "") return "no_webhook";
  if (!sameTelegramWebhookUrl(info.url, expectedUrl)) return "foreign_url";
  if (info.hasCustomCertificate) return "custom_certificate";
  return null;
}

export async function ensureTelegramWebhookSubscription(
  options: TelegramWebhookCallOptions & {
    /** `TELEGRAM_WEBHOOK_IP_ADDRESS`; absent or empty means no fixed IP. */
    readonly ipAddress?: string | undefined;
    /** `PUBLIC_BASE_URL`: the https origin the installer registered the webhook under. */
    readonly publicBaseUrl: string | undefined;
    readonly secretToken: string;
  },
): Promise<TelegramWebhookSubscriptionOutcome> {
  if (!SECRET_PATTERN.test(options.secretToken)) {
    throw new AppError("AGENT_TELEGRAM_CONFIG_MISSING", "Не задан корректный секрет вебхука Telegram");
  }
  const ipAddress = telegramWebhookIpAddress(options.ipAddress);
  const expectedUrl = expectedTelegramWebhookUrl(options.publicBaseUrl);
  if (expectedUrl === null) return "expected_url_unknown";
  const info = await readTelegramWebhookInfo(options);
  const foreign = ownWebhook(info, expectedUrl);
  if (foreign !== null) return foreign;
  if (sameUpdates(info.allowedUpdates)) return "unchanged";

  let response;
  try {
    response = await callTelegramApi({
      body: {
        allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
        ...(ipAddress === null ? {} : { ip_address: ipAddress }),
        ...(info.maxConnections === null ? {} : { max_connections: info.maxConnections }),
        secret_token: options.secretToken,
        url: info.url,
      },
      botToken: options.botToken,
      fetch: boundedTelegramFetch(options),
      method: "setWebhook",
    });
  } catch {
    throw new AppError("AGENT_TELEGRAM_WEBHOOK_SUBSCRIPTION_FAILED", "Не удалось связаться с Telegram для обновления вебхука");
  }
  if (!response.ok || (response.body as { result?: unknown } | null)?.result !== true) {
    throw new AppError(
      "AGENT_TELEGRAM_WEBHOOK_SUBSCRIPTION_FAILED",
      `Telegram не принял обновлённый список апдейтов (HTTP ${response.status})`,
    );
  }
  // Telegram must now report the same webhook with the new list, or the change did not take.
  const confirmed = await readTelegramWebhookInfo(options);
  if (confirmed.url !== info.url || !sameUpdates(confirmed.allowedUpdates)) {
    throw new AppError(
      "AGENT_TELEGRAM_WEBHOOK_SUBSCRIPTION_UNCONFIRMED",
      "Telegram не подтвердил обновлённый список апдейтов вебхука",
    );
  }
  return "updated";
}
