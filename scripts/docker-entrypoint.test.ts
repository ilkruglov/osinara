/**
 * Start-time configuration checks of the agent container entrypoint.
 *
 * Constructs covered:
 * - The webhook secret must be 32-256 characters of the Telegram secret_token alphabet before
 *   anything starts: one secret guards the webhook, the drain route and the approval sweep
 *   (security review, 5 October 2026). The Zod schema in agent/config.ts says the same but is
 *   not what refuses a start.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ENTRYPOINT = fileURLToPath(new URL("./docker-entrypoint.sh", import.meta.url));

function start(secret: string) {
  return spawnSync("sh", [ENTRYPOINT], {
    encoding: "utf8",
    env: {
      DATABASE_URL: "postgresql://unused@127.0.0.1:1/unused",
      INVITATION_SIGNING_SECRET: "i".repeat(32),
      MODEL_API_KEY: "unused",
      PATH: process.env.PATH,
      TELEGRAM_BOT_TOKEN: "1:unused",
      TELEGRAM_BOT_USERNAME: "unused",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: secret,
    },
    timeout: 20_000,
  });
}

describe("docker entrypoint", () => {
  it.each([
    ["shorter than 32 characters", "s".repeat(31)],
    ["outside the Telegram alphabet", `${"s".repeat(40)}!`],
    ["longer than Telegram accepts", "s".repeat(257)],
  ])("refuses a webhook secret %s", (_label, secret) => {
    const result = start(secret);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("AGENT_TELEGRAM_WEBHOOK_SECRET_WEAK");
  });

  it("passes a 43-character base64url secret, as the installer generates", () => {
    // It fails later (no model configuration here), but not on the secret.
    expect(start("A".repeat(21) + "-_" + "z".repeat(20)).stderr).not.toContain("AGENT_TELEGRAM_WEBHOOK_SECRET_WEAK");
  });
});
