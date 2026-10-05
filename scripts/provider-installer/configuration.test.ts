/**
 * Installer configuration tests.
 *
 * Constructs covered:
 * - Provider selection contract: DeepSeek is the only release variant.
 * - Internal secret generation and required credential validation.
 * - Owner bootstrap deep-link output with an explicit expiry contract.
 */
import { describe, expect, it, vi } from "vitest";

import {
  MODEL_PROVIDER_OPTIONS,
  buildOwnerBootstrapOutput,
  generateInternalSecrets,
  requireCredential,
} from "./configuration.js";

describe("provider installer configuration", () => {
  it("offers DeepSeek as the only provider variant", () => {
    expect(MODEL_PROVIDER_OPTIONS.map(({ value }) => value)).toEqual(["deepseek"]);
  });

  it("generates each required internal secret independently", () => {
    const generate = vi.fn((purpose: string) => `secret-${purpose}-abcdefghijklmnopqrstuvwxyz`);
    const secrets = generateInternalSecrets(generate);

    expect(generate).toHaveBeenCalledTimes(6);
    expect(Object.keys(secrets).sort()).toEqual([
      "agentInternalToken",
      "appDatabasePassword",
      "invitationSigningSecret",
      "postgresPassword",
      "telegramWebhookSecretToken",
      "workflowPostgresPassword",
    ]);
    expect(new Set(Object.values(secrets)).size).toBe(6);
  });

  it("rejects missing or whitespace-containing required credentials", () => {
    expect(() => requireCredential(" ", "model API key")).toThrowError(
      /OSINARA_INSTALL_CREDENTIAL_INVALID/,
    );
    expect(() => requireCredential("key with spaces", "model API key")).toThrowError(
      /OSINARA_INSTALL_CREDENTIAL_INVALID/,
    );
  });

  it("returns the stable owner bootstrap deep-link contract", () => {
    expect(
      buildOwnerBootstrapOutput({
        botUsername: "Osinara_Test_Bot",
        code: "bootstrap_secret-123",
        expiresAt: "2026-08-12T12:15:00.000Z",
      }),
    ).toEqual({
      code: "OSINARA_OWNER_BOOTSTRAP_READY",
      expiresAt: "2026-08-12T12:15:00.000Z",
      url: "https://t.me/Osinara_Test_Bot?start=bootstrap_secret-123",
    });
  });
});
