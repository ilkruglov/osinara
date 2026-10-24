/**
 * Webhook subscription check tests.
 *
 * Constructs covered:
 * - `ensureTelegramWebhookSubscription`: leaves a matching list alone; otherwise repeats `setWebhook`
 *   with the same URL, the agent's secret and the current `max_connections`, then confirms.
 * - The webhook is ours only when its whole URL is `PUBLIC_BASE_URL` + `/eve/v1/telegram` (a trailing
 *   slash aside): a foreign host with the same path, no webhook or a custom certificate is never touched,
 *   and without a valid `PUBLIC_BASE_URL` Telegram is not even asked.
 * - `ip_address` comes only from `TELEGRAM_WEBHOOK_IP_ADDRESS`; an invalid value fails before any call.
 */
import { describe, expect, it, vi } from "vitest";

import { TELEGRAM_ALLOWED_UPDATES } from "./allowed-updates.js";
import { ensureTelegramWebhookSubscription } from "./webhook-subscription.js";

const PUBLIC_BASE_URL = "https://5-45-116-217.sslip.io/";
const URL_NOW = "https://5-45-116-217.sslip.io/eve/v1/telegram";
const SECRET = "webhook_secret-0123456789abcdef0123456789";

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

function info(result: Record<string, unknown>): Response {
  return answer({ ok: true, result: { has_custom_certificate: false, pending_update_count: 0, url: URL_NOW, ...result } });
}

function check(fetchMock: typeof fetch, settings: { ipAddress?: string; publicBaseUrl?: string | undefined } = {}) {
  return ensureTelegramWebhookSubscription({
    botToken: "123:abc",
    fetch: fetchMock,
    ipAddress: settings.ipAddress,
    publicBaseUrl: "publicBaseUrl" in settings ? settings.publicBaseUrl : PUBLIC_BASE_URL,
    secretToken: SECRET,
  });
}

function setWebhookBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://api.telegram.org/bot123:abc/setWebhook");
  return JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body)) as Record<string, unknown>;
}

describe("ensureTelegramWebhookSubscription", () => {
  it("writes nothing when Telegram already sends every handled type, in any order", async () => {
    const fetchMock = vi.fn().mockResolvedValue(info({ allowed_updates: [...TELEGRAM_ALLOWED_UPDATES].reverse() }));

    await expect(check(fetchMock)).resolves.toBe("unchanged");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("subscribes an older installation to the missing type without moving or resetting its webhook", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(info({
        allowed_updates: ["message", "callback_query", "message_reaction"],
        max_connections: 10,
        pending_update_count: 7,
      }))
      .mockResolvedValueOnce(answer({ ok: true, result: true }))
      .mockResolvedValueOnce(info({ allowed_updates: [...TELEGRAM_ALLOWED_UPDATES], max_connections: 10 }));

    await expect(check(fetchMock)).resolves.toBe("updated");

    expect(setWebhookBody(fetchMock)).toEqual({
      allowed_updates: ["message", "callback_query", "message_reaction", "my_chat_member"],
      max_connections: 10,
      secret_token: SECRET,
      url: URL_NOW,
    });
  });

  it("treats an absent list (Telegram's default) as different and sets the explicit one", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(info({}))
      .mockResolvedValueOnce(answer({ ok: true, result: true }))
      .mockResolvedValueOnce(info({ allowed_updates: [...TELEGRAM_ALLOWED_UPDATES] }));

    await expect(check(fetchMock)).resolves.toBe("updated");
    expect(setWebhookBody(fetchMock)).not.toHaveProperty("max_connections");
  });

  it("takes its own URL with a trailing slash or another host case as its own", async () => {
    const reported = "https://5-45-116-217.SSLIP.io/eve/v1/telegram/";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(info({ allowed_updates: ["message"], url: reported }))
      .mockResolvedValueOnce(answer({ ok: true, result: true }))
      .mockResolvedValueOnce(info({ allowed_updates: [...TELEGRAM_ALLOWED_UPDATES], url: reported }));

    await expect(check(fetchMock, { publicBaseUrl: "https://5-45-116-217.sslip.io" })).resolves.toBe("updated");
    expect(setWebhookBody(fetchMock)).toMatchObject({ url: reported });
  });

  it.each([
    ["no_webhook", { url: "" }],
    ["foreign_url", { url: "https://relay.example.com/eve/v1/telegram" }],
    ["foreign_url", { url: "https://5-45-116-217.sslip.io/other/path" }],
    ["foreign_url", { url: "http://5-45-116-217.sslip.io/eve/v1/telegram" }],
    ["foreign_url", { url: "https://5-45-116-217.sslip.io/eve/v1/telegram?relay=1" }],
    ["custom_certificate", { has_custom_certificate: true }],
  ])("leaves a webhook it cannot have set alone (%s)", async (outcome, result) => {
    const fetchMock = vi.fn().mockResolvedValue(info({ allowed_updates: ["message"], ...result }));

    await expect(check(fetchMock)).resolves.toBe(outcome);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "", "not a url", "http://5-45-116-217.sslip.io", "https://5-45-116-217.sslip.io/base"])(
    "changes nothing and asks nothing without a valid PUBLIC_BASE_URL (%j)",
    async (publicBaseUrl) => {
      const fetchMock = vi.fn();
      await expect(check(fetchMock, { publicBaseUrl })).resolves.toBe("expected_url_unknown");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("fixes the IP only from TELEGRAM_WEBHOOK_IP_ADDRESS and refuses an invalid one before any call", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(info({ allowed_updates: ["message"], ip_address: "198.51.100.9" }))
      .mockResolvedValueOnce(answer({ ok: true, result: true }))
      .mockResolvedValueOnce(info({ allowed_updates: [...TELEGRAM_ALLOWED_UPDATES] }));
    await expect(check(fetchMock, { ipAddress: "2001:db8::7" })).resolves.toBe("updated");
    expect(setWebhookBody(fetchMock)).toMatchObject({ ip_address: "2001:db8::7" });

    const withoutSetting = vi.fn()
      .mockResolvedValueOnce(info({ allowed_updates: ["message"], ip_address: "198.51.100.9" }))
      .mockResolvedValueOnce(answer({ ok: true, result: true }))
      .mockResolvedValueOnce(info({ allowed_updates: [...TELEGRAM_ALLOWED_UPDATES] }));
    await expect(check(withoutSetting)).resolves.toBe("updated");
    expect(setWebhookBody(withoutSetting)).not.toHaveProperty("ip_address");

    const invalid = vi.fn();
    await expect(check(invalid, { ipAddress: "5.45.116" }))
      .rejects.toMatchObject({ code: "AGENT_TELEGRAM_WEBHOOK_IP_ADDRESS_INVALID" });
    expect(invalid).not.toHaveBeenCalled();
  });

  it("fails with a code when Telegram refuses or does not confirm the new list", async () => {
    const refused = vi.fn()
      .mockResolvedValueOnce(info({ allowed_updates: ["message"] }))
      .mockResolvedValueOnce(answer({ description: "Bad Request: bad webhook", ok: false }, 400));
    await expect(check(refused)).rejects.toMatchObject({ code: "AGENT_TELEGRAM_WEBHOOK_SUBSCRIPTION_FAILED" });

    const unconfirmed = vi.fn()
      .mockResolvedValueOnce(info({ allowed_updates: ["message"] }))
      .mockResolvedValueOnce(answer({ ok: true, result: true }))
      .mockResolvedValueOnce(info({ allowed_updates: ["message"] }));
    await expect(check(unconfirmed)).rejects.toMatchObject({ code: "AGENT_TELEGRAM_WEBHOOK_SUBSCRIPTION_UNCONFIRMED" });
  });

  it("refuses to run without a valid webhook secret", async () => {
    const fetchMock = vi.fn();
    await expect(ensureTelegramWebhookSubscription({
      botToken: "123:abc", fetch: fetchMock, publicBaseUrl: PUBLIC_BASE_URL, secretToken: "",
    })).rejects.toMatchObject({ code: "AGENT_TELEGRAM_CONFIG_MISSING" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
