/**
 * Workflow queue loopback timeout patch tests.
 *
 * Constructs covered:
 * - The queue calls the agent's own flow route with undici's fetch and a dispatcher whose header
 *   and body timeouts outlast any step, instead of Node's fetch with its fixed 300 s header wait.
 * - The world's start() also starts the stuck-run scan and close() stops it.
 * - The flow route the queue posts to is opened by the internal token: the queue sends it and
 *   the handler checks it before anything else, timing-safe (security audit, 6 October 2026,
 *   N-2: the route checked header shape but no secret, trusting network position alone).
 * - The patched modules stay syntactically valid.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { codeShape, codeText } from "./vendored-code.js";

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

    expect(codeText(queue)).toContain(codeText("import { Agent as OsinaraLoopbackAgent, fetch as osinaraLoopbackFetch, } from \"undici\""));
    expect(codeText(queue)).toContain(codeText("const OSINARA_LOOPBACK_TIMEOUT_MS = 20 * 60 * 1000"));
    expect(codeText(queue)).toContain(codeText("headersTimeout: OSINARA_LOOPBACK_TIMEOUT_MS"));
    expect(codeText(queue)).toContain(codeText("bodyTimeout: OSINARA_LOOPBACK_TIMEOUT_MS"));
    expect(codeText(queue)).toContain(codeText("const response = await osinaraLoopbackFetch( createWorkflowUrl(baseUrl, { type: \"flow\" }), {"));
    expect(codeText(queue)).toContain(codeText("dispatcher: OSINARA_LOOPBACK_DISPATCHER"));
    expect(codeShape(queue)).not.toContain(codeShape("const response = await fetch(createWorkflowUrl(baseUrl, { type: 'flow' }), {"));
  });

  it("re-enqueues runs whose retry job was lost without waiting for a restart", async () => {
    const index = await readFile(INDEX_PATH, "utf8");

    expect(codeText(index)).toContain(codeText("import { releaseDeadWorkerLocks, requeueInFlightRuns, startStuckRunRecovery } from \"./osinara-stuck-run-recovery.js\""));
    // Locks of the previous process's workers are released before anything is re-enqueued.
    expect(codeText(index)).toContain(codeText("await releaseDeadWorkerLocks(pool, startedAt);"));
    // Startup re-enqueues the interrupted runs only; parked sessions wake on their hook.
    expect(codeText(index)).toContain(codeText("await requeueInFlightRuns({"));
    expect(index).not.toContain("reenqueueActiveRuns");
    expect(codeText(index)).toContain(codeText("stopStuckRunRecovery ??= startStuckRunRecovery({"));
    expect(codeText(index)).toContain(codeText("queuePrefix: getQueueTopicPrefix( \"workflow\", resolveQueueNamespace(config.namespace"));
    expect(codeText(index)).toContain(codeText("stopStuckRunRecovery?."));
  });

  it("opens the flow route with the internal token only", async () => {
    const queue = await readFile(QUEUE_PATH, "utf8");
    // The queue sends the token with every flow request.
    expect(codeText(queue)).toContain(codeText('"x-osinara-internal-token": requireInternalToken(),'));
    // The handler refuses before the official one parses anything; a wrong or missing token is 401.
    expect(codeText(queue)).toContain(codeText("const createQueueHandler = (prefix, handle) => {"));
    expect(codeText(queue)).toContain(codeText('if (!isInternalTokenAuthorized(request.headers.get("x-osinara-internal-token")))'));
    expect(codeText(queue)).toContain(codeText("return new Response(null, { status: 401 });"));
    // The official handler is built once per route, not per request.
    expect(codeText(queue)).toContain(codeText("const official = localWorld.createQueueHandler(prefix, handle);"));
    expect(codeText(queue)).toContain(codeText("return official(request);"));
    expect(codeText(queue)).toContain(codeText("timingSafeEqual"));
    expect(codeShape(queue)).not.toContain(codeShape("const createQueueHandler = localWorld.createQueueHandler;"));
  });

  it("keeps the patched modules syntactically valid", async () => {
    for (const path of [QUEUE_PATH, INDEX_PATH, RECOVERY_PATH]) {
      await expect(execFileAsync(process.execPath, ["--check", path])).resolves.toMatchObject({ stderr: "" });
    }
  });
});
