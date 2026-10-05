/**
 * Runtime environment validation tests.
 *
 * Constructs covered:
 * - `requireRuntimeEnvironment`: requires the agent-model credential and permits optional voice;
 *   the internal token is as strong as the webhook secret and differs from it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  requireRuntimeEnvironment,
  TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES,
  TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES,
} from "./config.js";

function stubRequiredEnvironment(): void {
  vi.stubEnv("AGENT_INTERNAL_TOKEN", "agent-internal-test-token-0123456789");
  vi.stubEnv("MODEL_API_KEY", "agent-model-test-key");
  vi.stubEnv("DATABASE_URL", "postgresql://test:test@postgres:5432/osinara_test");
  vi.stubEnv("GROQ_API_KEY", "groq-test-key");
  vi.stubEnv("INVITATION_SIGNING_SECRET", "12345678901234567890123456789012");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-test-token");
  vi.stubEnv("TELEGRAM_BOT_USERNAME", "osinara_test_bot");
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET_TOKEN", "telegram-webhook-test-secret-0123456789");
}

describe("requireRuntimeEnvironment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts complete voice and agent provider configuration", () => {
    stubRequiredEnvironment();

    expect(requireRuntimeEnvironment()).toMatchObject({
      MODEL_API_KEY: "agent-model-test-key",
      GROQ_API_KEY: "groq-test-key",
    });
  });

  it("allows voice transcription to remain unconfigured", () => {
    stubRequiredEnvironment();
    vi.stubEnv("GROQ_API_KEY", "");

    expect(requireRuntimeEnvironment().GROQ_API_KEY).toBeUndefined();
  });

  it.each([
    ["shorter than 32 characters", "s".repeat(31)],
    ["outside the Telegram alphabet", `${"s".repeat(40)}!`],
    ["longer than Telegram accepts", "s".repeat(257)],
  ])("rejects a webhook secret %s", (_label, secret) => {
    // As strong as the invitation signing secret (security review, 5 October 2026).
    stubRequiredEnvironment();
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET_TOKEN", secret);

    expect(() => requireRuntimeEnvironment()).toThrowError(/TELEGRAM_WEBHOOK_SECRET_TOKEN/);
  });

  it.each([
    ["missing", ""],
    ["shorter than 32 characters", "s".repeat(31)],
    ["equal to the webhook secret", "telegram-webhook-test-secret-0123456789"],
  ])("rejects an internal token %s", (_label, token) => {
    // Telegram holds the webhook secret; it must not also open the drain route and the sweep.
    stubRequiredEnvironment();
    vi.stubEnv("AGENT_INTERNAL_TOKEN", token);

    expect(() => requireRuntimeEnvironment()).toThrowError(/AGENT_INTERNAL_TOKEN/);
  });

  it("rejects missing credentials for the active agent model route", () => {
    stubRequiredEnvironment();
    vi.stubEnv("MODEL_API_KEY", "");

    expect(() => requireRuntimeEnvironment()).toThrowError(/MODEL_API_KEY/);
  });
});

describe("Telegram timeline limits", () => {
  it("retains ten thousand messages and admits one hundred per turn context", () => {
    expect(TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES).toBe(10_000);
    expect(TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES).toBe(100);
  });
});

describe("private burst tuning", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("refuses a cap below the quiet window at load", async () => {
    vi.resetModules();
    vi.stubEnv("TELEGRAM_PRIVATE_BURST_QUIET_MS", "30000");
    vi.stubEnv("TELEGRAM_PRIVATE_BURST_MAX_WAIT_MS", "20000");

    await expect(import("./config.js")).rejects.toThrow(expect.objectContaining({ code: "AGENT_RUNTIME_TUNING_INVALID" }));
  });

  it("takes a consistent pair from the environment", async () => {
    vi.resetModules();
    vi.stubEnv("TELEGRAM_PRIVATE_BURST_QUIET_MS", "700");
    vi.stubEnv("TELEGRAM_PRIVATE_BURST_MAX_WAIT_MS", "20000");

    const config = await import("./config.js");
    expect(config.TELEGRAM_PRIVATE_BURST_QUIET_MS).toBe(700);
    expect(config.TELEGRAM_PRIVATE_BURST_MAX_WAIT_MS).toBe(20_000);
  });
});
