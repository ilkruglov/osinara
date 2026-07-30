/**
 * Runtime environment validation tests.
 *
 * Constructs covered:
 * - `requireRuntimeEnvironment`: requires independent agent-model and Groq voice credentials.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { requireRuntimeEnvironment } from "./config.js";

function stubRequiredEnvironment(): void {
  vi.stubEnv("MODEL_UPSTREAM_API_KEY", "agent-model-test-key");
  vi.stubEnv("DATABASE_URL", "postgresql://test:test@postgres:5432/osinara_test");
  vi.stubEnv("GROQ_API_KEY", "groq-test-key");
  vi.stubEnv("INVITATION_SIGNING_SECRET", "12345678901234567890123456789012");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-test-token");
  vi.stubEnv("TELEGRAM_BOT_USERNAME", "osinara_test_bot");
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET_TOKEN", "telegram-webhook-test-secret");
}

describe("requireRuntimeEnvironment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts complete voice and agent provider configuration", () => {
    stubRequiredEnvironment();

    expect(requireRuntimeEnvironment()).toMatchObject({
      MODEL_UPSTREAM_API_KEY: "agent-model-test-key",
      GROQ_API_KEY: "groq-test-key",
    });
  });

  it("rejects missing credentials for the active Groq route", () => {
    stubRequiredEnvironment();
    vi.stubEnv("GROQ_API_KEY", "");

    expect(() => requireRuntimeEnvironment()).toThrowError(/GROQ_API_KEY/);
  });

  it("rejects missing credentials for the active agent model route", () => {
    stubRequiredEnvironment();
    vi.stubEnv("MODEL_UPSTREAM_API_KEY", "");

    expect(() => requireRuntimeEnvironment()).toThrowError(/MODEL_UPSTREAM_API_KEY/);
  });
});
