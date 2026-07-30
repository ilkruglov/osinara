/**
 * Deployment-compatible CLIProxy runtime tests.
 *
 * Constructs covered:
 * - Compatibility config remains isolated from active agent model transport configuration.
 * - Entrypoint emits an authenticated, no-retry OpenAI-compatible route for the retained service.
 * - Missing compatibility credentials fail before the proxy process starts.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const entrypoint = resolve("infra/cli-proxy-entrypoint.sh");
const compatibilityConfig = resolve("config/cli-proxy-compatibility.json");

describe("CLIProxy deployment compatibility runtime", () => {
  it("renders an authenticated no-retry route from its isolated config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "osinara-cli-proxy-"));
    const target = join(directory, "config.json");
    try {
      await execFileAsync("sh", [entrypoint, compatibilityConfig, target, "/bin/true"], {
        env: {
          ...process.env,
          CLI_PROXY_API_KEY: "client-test-key",
          MODEL_UPSTREAM_API_KEY: "upstream-test-key",
        },
      });
      const rendered = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
      const activeAgentConfig = JSON.parse(
        await readFile("config/agent-model-providers.json", "utf8"),
      ) as { agent?: { transport?: { protocol?: string } } };

      expect(rendered).toMatchObject({
        "api-keys": ["client-test-key"],
        "request-retry": 0,
        "openai-compatibility": [{
          "base-url": "https://api.minimax.io/v1",
          "api-key-entries": [{ "api-key": "upstream-test-key" }],
          models: [{ alias: "MiniMax-M3", name: "MiniMax-M3" }],
        }],
      });
      expect(activeAgentConfig.agent?.transport?.protocol).toBe("anthropic-messages");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("fails fast when a retained service credential is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "osinara-cli-proxy-"));
    try {
      await expect(execFileAsync("sh", [
        entrypoint,
        compatibilityConfig,
        join(directory, "config.json"),
        "/bin/true",
      ], {
        env: {
          ...process.env,
          CLI_PROXY_API_KEY: "client-test-key",
          MODEL_UPSTREAM_API_KEY: "",
        },
      })).rejects.toMatchObject({
        stderr: expect.stringContaining("CLI_PROXY_REQUIRED_CONFIG_MISSING"),
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
