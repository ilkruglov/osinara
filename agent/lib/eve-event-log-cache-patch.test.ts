/**
 * Workflow event log cache patch tests.
 *
 * Constructs covered:
 * - Resuming a run reuses the log it already read and fetches only the tail.
 * - Only a listing that reached the end of the log is stored for reuse, and each resume is traced.
 * - Every workflow pool query slower than the threshold names itself.
 * - The patched storage module and the installed cache stay syntactically valid.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { codeShape } from "./vendored-code.js";

const STORAGE_PATH = "vendor/workflow-world-postgres/dist/storage.js";
const CACHE_PATH = "vendor/workflow-world-postgres/dist/osinara-event-log-cache.js";
const execFileAsync = promisify(execFile);

describe("workflow event log cache patch", () => {
  it("reads a cached run log and extends it by the tail", async () => {
    const storage = await readFile(STORAGE_PATH, "utf8");

    // A 43-turn session carried 585 events and 9 MB of payloads that were re-read on every
    // message before the model was called (10 сентября 2026).
    expect(codeShape(storage)).toContain(codeShape("const cacheKey = eventLogCacheKey(params, resolveData, sortOrder);"));
    expect(codeShape(storage)).toContain(codeShape("let cached = cacheKey === null ? undefined : readEventLogCache(cacheKey);"));
    expect(codeShape(storage)).toContain(codeShape("const data = cached === undefined ? [] : [...cached.data];"));
    // A shrunk log must never be served from a stale prefix.
    expect(codeShape(storage)).toContain(codeShape("if (total < cached.data.length) {"));
    expect(codeShape(storage)).toContain(codeShape("dropEventLogCache(cacheKey);"));
    // Only a complete listing becomes a prefix for the next resume, and every resume reports itself.
    expect(codeShape(storage)).toContain(codeShape("if (!hasMore) writeEventLogCache(cacheKey, data, data.at(-1)?.eventId);"));
    expect(codeShape(storage)).toContain(codeShape("traceEventLogRead(params.runId, reusedEvents,"));
  });

  it("traces slow driver queries from the one pool the driver builds", async () => {
    const [index, trace] = await Promise.all([
      readFile("vendor/workflow-world-postgres/dist/index.js", "utf8"),
      readFile("vendor/workflow-world-postgres/dist/osinara-workflow-pool-trace.js", "utf8"),
    ]);

    expect(codeShape(index)).toContain(codeShape("traceWorkflowPool(pool);"));
    expect(codeShape(trace)).toContain(codeShape("AGENT_WORKFLOW_SLOW_QUERY"));
    // Parameter values carry the turn context of a family chat and never reach the log.
    expect(codeShape(trace)).toContain(codeShape("statement: statementShape(args[0])"));
  });

  it("installs the cache module next to the driver", async () => {
    const cache = await readFile(CACHE_PATH, "utf8");

    expect(codeShape(cache)).toContain(codeShape("export function eventLogCacheKey"));
    expect(cache).not.toMatch(/:\s*(string|number|boolean)\b/u);
  });

  it("keeps both patched modules syntactically valid", async () => {
    for (const path of [STORAGE_PATH, CACHE_PATH]) {
      await expect(execFileAsync(process.execPath, ["--check", path])).resolves.toMatchObject({
        stderr: "",
      });
    }
  });
});
