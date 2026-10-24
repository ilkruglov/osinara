/**
 * Webhook target tests.
 *
 * Constructs covered:
 * - `expectedTelegramWebhookUrl`: `PUBLIC_BASE_URL` as an https origin, with or without a trailing slash;
 *   anything else is unknown.
 * - `sameTelegramWebhookUrl`: equal up to host case, default port and a trailing slash; another host,
 *   scheme, path or a query is different.
 * - `telegramWebhookIpAddress`: absent or empty is no setting; IPv4 and IPv6 pass; anything else is refused.
 */
import { describe, expect, it } from "vitest";

import { expectedTelegramWebhookUrl, sameTelegramWebhookUrl, telegramWebhookIpAddress } from "./webhook-target.js";

describe("expectedTelegramWebhookUrl", () => {
  it("builds the webhook URL from an https origin and refuses anything else", () => {
    expect(expectedTelegramWebhookUrl("https://5-45-116-217.sslip.io/")).toBe("https://5-45-116-217.sslip.io/eve/v1/telegram");
    expect(expectedTelegramWebhookUrl("https://bot.example.com")).toBe("https://bot.example.com/eve/v1/telegram");
    for (const value of [undefined, "", "bot.example.com", "http://bot.example.com", "https://bot.example.com/base",
      "https://bot.example.com/?x=1", "https://user:pass@bot.example.com"]) {
      expect(expectedTelegramWebhookUrl(value)).toBeNull();
    }
  });
});

describe("sameTelegramWebhookUrl", () => {
  it("ignores host case, default port and a trailing slash, nothing else", () => {
    const own = "https://bot.example.com/eve/v1/telegram";
    expect(sameTelegramWebhookUrl("https://BOT.example.com:443/eve/v1/telegram/", own)).toBe(true);
    expect(sameTelegramWebhookUrl("https://evil.example.com/eve/v1/telegram", own)).toBe(false);
    expect(sameTelegramWebhookUrl("http://bot.example.com/eve/v1/telegram", own)).toBe(false);
    expect(sameTelegramWebhookUrl("https://bot.example.com:8443/eve/v1/telegram", own)).toBe(false);
    expect(sameTelegramWebhookUrl("https://bot.example.com/eve/v1/telegram?x=1", own)).toBe(false);
    expect(sameTelegramWebhookUrl("not a url", own)).toBe(false);
  });
});

describe("telegramWebhookIpAddress", () => {
  it("passes IPv4 and IPv6, treats absent as no setting and refuses the rest", () => {
    expect(telegramWebhookIpAddress(undefined)).toBeNull();
    expect(telegramWebhookIpAddress("")).toBeNull();
    expect(telegramWebhookIpAddress("5.45.116.217")).toBe("5.45.116.217");
    expect(telegramWebhookIpAddress("2001:db8::1")).toBe("2001:db8::1");
    for (const value of ["5.45.116", "bot.example.com", " 5.45.116.217"]) {
      expect(() => telegramWebhookIpAddress(value)).toThrow(expect.objectContaining({ code: "AGENT_TELEGRAM_WEBHOOK_IP_ADDRESS_INVALID" }));
    }
  });
});
