/**
 * Where this installation's Telegram webhook points, shared by the installer and the running agent.
 *
 * Exports:
 * - `TELEGRAM_WEBHOOK_PATH`: the path of the verified webhook route.
 * - `telegramWebhookUrl`: the webhook URL for an https origin; the installer and the agent build it alike.
 * - `expectedTelegramWebhookUrl`: the URL from `PUBLIC_BASE_URL`, or null when it is unset or not an
 *   https origin without a path.
 * - `sameTelegramWebhookUrl`: two webhook URLs equal up to host case, default port and a trailing slash.
 * - `telegramWebhookIpAddress`: the optional `TELEGRAM_WEBHOOK_IP_ADDRESS`, validated as IPv4 or IPv6.
 *
 * Key constructs:
 * - The webhook is ours only when its whole URL is the one this installation registers: a foreign host
 *   with the same path must never receive our `secret_token`. The installer writes `PUBLIC_BASE_URL` as
 *   `https://<hostname>` and registers `https://<hostname>/eve/v1/telegram`.
 * - The IP Telegram delivers to is fixed only by this explicit setting (`setWebhook.ip_address`, Bot API
 *   10.3). Our installers never fix one; an IP fixed by hand outside the setting is not supported: the
 *   next `setWebhook` without the field lets Telegram resolve the host through DNS again.
 */
import { isIP } from "node:net";

import { AppError } from "../app-error.js";

export const TELEGRAM_WEBHOOK_PATH = "/eve/v1/telegram";

export function telegramWebhookUrl(origin: string): string {
  return `${origin}${TELEGRAM_WEBHOOK_PATH}`;
}

export function expectedTelegramWebhookUrl(publicBaseUrl: string | undefined): string | null {
  if (!publicBaseUrl) return null;
  let url: URL;
  try {
    url = new URL(publicBaseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search !== "" || url.hash !== "" ||
      url.username !== "" || url.password !== "") return null;
  return telegramWebhookUrl(url.origin);
}

function canonical(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") return null;
  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}

export function sameTelegramWebhookUrl(left: string, right: string): boolean {
  const a = canonical(left);
  return a !== null && a === canonical(right);
}

export function telegramWebhookIpAddress(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  if (isIP(value) === 0) {
    throw new AppError(
      "AGENT_TELEGRAM_WEBHOOK_IP_ADDRESS_INVALID",
      "TELEGRAM_WEBHOOK_IP_ADDRESS должен быть адресом IPv4 или IPv6",
    );
  }
  return value;
}
