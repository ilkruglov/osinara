/**
 * Run the real application channel and native Eve lifecycle against the isolated test database.
 *
 * The script lives in `stress/telegram-conversation`: PostgreSQL, the Telegram channel, the durable
 * queue, sessions, memory context and sandbox hooks are real; the model and the Telegram network are
 * test doubles. It does not use `NODE_ENV=test`, which makes Eve skip authored models and sandboxes.
 */
import { execFile } from "node:child_process";
import { cp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// The script resets and migrates the disposable workflow database, so it also needs its URL.
const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" &&
    typeof process.env.WORKFLOW_POSTGRES_URL === "string"
  ? describe
  : describe.skip;
const run = promisify(execFile);

describeWithDatabase("Telegram conversation end-to-end", () => {
  it("answers humans and another bot through a new session after 50 turns", async () => {
    const root = resolve("stress/telegram-conversation");
    const env = {
      ...process.env,
      NODE_ENV: "development",
      EVE_MOCK_AUTHORED_MODELS: "0",
      TELEGRAM_BOT_TOKEN: "conversation-test-token",
      TELEGRAM_BOT_USERNAME: "osinara_test_bot",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "conversation-test-secret",
      MODEL_API_KEY: "unused-test-key",
      MEMORY_EMBEDDING_BASE_URL: "http://memory-test",
      WORKFLOW_STRESS_RESET_ALLOWED: "true",
      WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "10",
      WORKFLOW_POSTGRES_MAX_POOL_SIZE: "12",
    };
    await run(process.execPath, ["--experimental-strip-types", "scripts/reset-workflow-stress-database.ts"], { env });
    await run(process.execPath, ["--experimental-strip-types", "scripts/migrate-workflow.ts"], { env });
    await cp(resolve("config"), resolve(root, "config"), { recursive: true });
    try {
      await run(resolve("node_modules/.bin/tsc"), ["--project", resolve(root, "tsconfig.json")], { env });
      const result = await run(resolve("node_modules/.bin/eve"), [
        "eval", "conversation", "--max-concurrency", "1", "--timeout", "480000", "--verbose",
      ], {
        cwd: root,
        env,
        maxBuffer: 32 * 1024 * 1024,
        timeout: 540_000,
      });
      expect(result.stdout).toContain("verified 56 turns, 4 sessions");
      expect(result.stderr).not.toContain("AGENT_MEMORY_UNAVAILABLE");
    } catch (error) {
      const output = error as { stdout?: string; stderr?: string };
      throw new Error(`TEST_TELEGRAM_CONVERSATION_FAILED: ${output.stdout ?? ""}\n${output.stderr ?? ""}`, { cause: error });
    } finally {
      await Promise.all([".eve", ".output", "eval-results", "reports", "config"].map((path) =>
        rm(resolve(root, path), { recursive: true, force: true })
      ));
    }
  }, 600_000);
});
