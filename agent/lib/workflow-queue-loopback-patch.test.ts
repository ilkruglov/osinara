/**
 * Workflow queue loopback timeout patch tests.
 *
 * Constructs covered:
 * - The queue calls the agent's own flow route with undici's fetch and a dispatcher whose header
 *   and body timeouts outlast any step, instead of Node's fetch with its fixed 300 s header wait.
 * - The world's start() also starts the stuck-run scan and close() stops it.
 * - The patched modules stay syntactically valid.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const QUEUE_PATH = "vendor/workflow-world-postgres/dist/queue.js";
const INDEX_PATH = "vendor/workflow-world-postgres/dist/index.js";
const RECOVERY_PATH = "vendor/workflow-world-postgres/dist/osinara-stuck-run-recovery.js";
const execFileAsync = promisify(execFile);

describe("workflow queue loopback patch", () => {
  // 1 October 2026: DeepSeek held requests for up to 900 s. Node's fetch gave up on the flow route
  // after 300 s, the queue retried while the first execution still ran (two model calls for one
  // step), and the retry that execution finally asked for was written to a closed connection, so
  // the step stayed pending and the private chat was silent for 8.5 hours.
  it("waits for a step longer than any step may run", async () => {
    const queue = await readFile(QUEUE_PATH, "utf8");

    expect(queue).toContain("import { Agent as OsinaraLoopbackAgent, fetch as osinaraLoopbackFetch } from 'undici';");
    expect(queue).toContain("const OSINARA_LOOPBACK_TIMEOUT_MS = 20 * 60 * 1000;");
    expect(queue).toContain("headersTimeout: OSINARA_LOOPBACK_TIMEOUT_MS,");
    expect(queue).toContain("bodyTimeout: OSINARA_LOOPBACK_TIMEOUT_MS,");
    expect(queue).toContain("const response = await osinaraLoopbackFetch(createWorkflowUrl(baseUrl, { type: 'flow' }), {");
    expect(queue).toContain("dispatcher: OSINARA_LOOPBACK_DISPATCHER,");
    expect(queue).not.toContain("const response = await fetch(createWorkflowUrl(baseUrl, { type: 'flow' }), {");
  });

  it("re-enqueues runs whose retry job was lost without waiting for a restart", async () => {
    const index = await readFile(INDEX_PATH, "utf8");

    expect(index).toContain("import { startStuckRunRecovery } from './osinara-stuck-run-recovery.js';");
    expect(index).toContain("stopStuckRunRecovery ??= startStuckRunRecovery({");
    expect(index).toContain("queuePrefix: getQueueTopicPrefix('workflow', resolveQueueNamespace(config.namespace)),");
    expect(index).toContain("stopStuckRunRecovery?.();");
  });

  it("keeps the patched modules syntactically valid", async () => {
    for (const path of [QUEUE_PATH, INDEX_PATH, RECOVERY_PATH]) {
      await expect(execFileAsync(process.execPath, ["--check", path])).resolves.toMatchObject({ stderr: "" });
    }
  });
});
