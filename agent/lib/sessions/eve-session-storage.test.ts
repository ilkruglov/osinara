/**
 * Eve 0.32.0 local workflow retention adapter tests.
 *
 * Constructs covered:
 * - `deleteLocalEveSession`: removes one complete run graph, including waits and locks.
 * - Run and hook lock cleanup preserves entries owned by other runs.
 * - Partial secondary deletion retains identity indexes and supports a complete retry.
 * - Corrupt secondary state leaves the primary run record available for repair.
 * - Fail-fast behavior for unknown or incomplete storage layouts.
 * - Eve 0.32.0 retention uses the framework's `.eve/.workflow-data` root.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const removalFailure = vi.hoisted(() => ({ path: "", remaining: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (
      path: Parameters<typeof actual.rm>[0],
      options: Parameters<typeof actual.rm>[1],
    ) => {
      if (String(path) === removalFailure.path && removalFailure.remaining > 0) {
        removalFailure.remaining -= 1;
        throw new Error("injected secondary removal failure");
      }
      return actual.rm(path, options);
    },
  };
});

import { deleteLocalEveSession } from "./eve-session-storage.js";

const temporaryRoots: string[] = [];

async function put(root: string, path: string, content: unknown): Promise<void> {
  const target = join(root, path);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, typeof content === "string" ? content : JSON.stringify(content));
}

afterEach(async () => {
  removalFailure.path = "";
  removalFailure.remaining = 0;
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("deleteLocalEveSession", () => {
  it("removes the selected run, stream chunks, and every hook index", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-eve-retention-"));
    temporaryRoots.push(root);
    const runId = "wrun_01KXB392VJ8YY13JMJ9YZAF5QR";
    const otherRunId = "wrun_01KXB3WRDW8D6K9YV82NFNSNKS";
    const hookId = "hook_01KXB392VJ7WV8K04QC5Z340YP";
    const otherHookId = "hook_01KXB3WRDW7WV8K04QC5Z340YP";
    const streamId = "strm_01KXB392VJ8YY13JMJ9YZAF5QR_user";

    await put(root, `runs/${runId}.json`, { id: runId });
    await put(root, `runs/${otherRunId}.json`, { id: otherRunId });
    await put(root, `steps/${runId}-step_1.json`, { runId });
    await put(root, `events/${runId}-event_1.json`, { runId });
    await put(root, `waits/${runId}-wait_1.json`, { runId, waitId: "wait_1" });
    await put(root, `streams/runs/${runId}.json`, { streams: [streamId] });
    await put(root, `streams/chunks/${streamId}/0001.json`, { text: "secret" });
    await put(root, `hooks/by-run/${runId}-${hookId}.json`, { hookId });
    await put(root, `hooks/${hookId}.json`, { hookId, runId });
    await put(root, `hooks/id-index/${hookId}/event.json`, { hookId });
    await put(root, "hooks/token-index/token/event.json", { hookId });
    await put(root, "hooks/tokens/token.json", { runId });

    // Eve lock entries can be files or directories and use namespace-specific delimiters.
    await put(root, `.locks/runs/${runId}.lock`, "selected");
    await put(root, `.locks/runs/${otherRunId}.lock`, "other");
    await put(root, `.locks/steps/${runId}-step_1/owner`, "selected");
    await put(root, `.locks/steps/${otherRunId}-step_1`, "other");
    await put(root, `.locks/waits/${runId}-wait_1`, "selected");
    await put(root, `.locks/waits/${otherRunId}-wait_1`, "other");
    await put(root, `.locks/hooks/${hookId}.lock/owner`, "selected");
    await put(root, `.locks/hooks/${otherHookId}.lock`, "other");

    await expect(deleteLocalEveSession(root, runId)).resolves.toMatchObject({
      hookCount: 1,
      streamCount: 1,
    });
    await expect(readFile(join(root, `runs/${runId}.json`), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, `runs/${otherRunId}.json`), "utf8")).resolves.toContain(otherRunId);
    await expect(readdir(join(root, "steps"))).resolves.toEqual([]);
    await expect(readdir(join(root, "events"))).resolves.toEqual([]);
    await expect(readdir(join(root, "waits"))).resolves.toEqual([]);
    await expect(readdir(join(root, "streams/chunks"))).resolves.toEqual([]);
    await expect(readdir(join(root, ".locks/runs"))).resolves.toEqual([`${otherRunId}.lock`]);
    await expect(readdir(join(root, ".locks/steps"))).resolves.toEqual([`${otherRunId}-step_1`]);
    await expect(readdir(join(root, ".locks/waits"))).resolves.toEqual([`${otherRunId}-wait_1`]);
    await expect(readdir(join(root, ".locks/hooks"))).resolves.toEqual([`${otherHookId}.lock`]);
  });

  it("keeps the primary run record when a corrupt hook index blocks secondary cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-eve-retention-corrupt-"));
    temporaryRoots.push(root);
    const runId = "wrun_01KXB4EA5APPDAASE4GKT76XQS";

    await put(root, `runs/${runId}.json`, { id: runId });
    await put(root, `streams/runs/${runId}.json`, { streams: [] });
    await put(root, `hooks/by-run/${runId}-corrupt.json`, "not-json");
    await mkdir(join(root, "steps"), { recursive: true });
    await mkdir(join(root, "events"), { recursive: true });

    await expect(deleteLocalEveSession(root, runId)).rejects.toThrow();
    await expect(readFile(join(root, `runs/${runId}.json`), "utf8")).resolves.toContain(runId);
  });

  it("retries after partial cleanup by retaining stream and hook identity indexes", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-eve-retention-retry-"));
    temporaryRoots.push(root);
    const runId = "wrun_01KXB5EA5APPDAASE4GKT76XQS";
    const hookId = "hook_01KXB5EA5APPDAASE4GKT76XQS";
    const streamId = "strm_01KXB5EA5APPDAASE4GKT76XQS_user";
    const streamIndex = join(root, `streams/runs/${runId}.json`);
    const hookIndex = join(root, `hooks/by-run/${runId}-${hookId}.json`);
    const chunk = join(root, `streams/chunks/${streamId}`);

    await put(root, `runs/${runId}.json`, { id: runId });
    await put(root, `steps/${runId}-step_1.json`, { runId });
    await put(root, `events/${runId}-event_1.json`, { runId });
    await put(root, `streams/runs/${runId}.json`, { streams: [streamId] });
    await put(root, `streams/chunks/${streamId}/0001.json`, { text: "secret" });
    await put(root, `hooks/by-run/${runId}-${hookId}.json`, { hookId });
    await put(root, `hooks/${hookId}.json`, { hookId, runId });

    removalFailure.path = chunk;
    removalFailure.remaining = 1;
    await expect(deleteLocalEveSession(root, runId))
      .rejects.toThrow("injected secondary removal failure");

    // A retry can still recover both identifier sets after arbitrary sibling cleanup completed.
    await expect(readFile(join(root, `runs/${runId}.json`), "utf8")).resolves.toContain(runId);
    await expect(readFile(streamIndex, "utf8")).resolves.toContain(streamId);
    await expect(readFile(hookIndex, "utf8")).resolves.toContain(hookId);

    await expect(deleteLocalEveSession(root, runId)).resolves.toEqual({
      hookCount: 1,
      streamCount: 1,
    });
    await expect(readFile(join(root, `runs/${runId}.json`), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(streamIndex, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(hookIndex, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a missing run instead of marking retention complete", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-eve-retention-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "runs"), { recursive: true });

    await expect(deleteLocalEveSession(root, "wrun_01KXB4EA5APPDAASE4GKT76XQS"))
      .rejects.toThrowError(/AGENT_EVE_SESSION_STORAGE_MISSING/);
  });

  it("accepts the lazily absent waits directory for a run that never slept", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-eve-retention-"));
    temporaryRoots.push(root);
    const runId = "wrun_01KXB4EA5APPDAASE4GKT76XQS";

    await put(root, `runs/${runId}.json`, { id: runId });
    await put(root, `streams/runs/${runId}.json`, { streams: [] });
    await mkdir(join(root, "hooks/by-run"), { recursive: true });
    await mkdir(join(root, "steps"), { recursive: true });
    await mkdir(join(root, "events"), { recursive: true });

    await expect(deleteLocalEveSession(root, runId)).resolves.toEqual({
      hookCount: 0,
      streamCount: 0,
    });
  });

  it("uses the Eve 0.32 local-world root and version contract", async () => {
    const adapter = await readFile(new URL("./eve-session-storage.ts", import.meta.url), "utf8");
    const retention = await readFile(new URL("./session-retention.ts", import.meta.url), "utf8");

    expect(adapter).toContain("Eve 0.32.0 local-workflow physical retention adapter");
    expect(adapter).toContain('const EVE_STORAGE_VERSION = "0.32.0"');
    expect(adapter).toContain('const WAITS_DIRECTORY = "waits"');
    expect(adapter).toContain("join(root, WAITS_DIRECTORY)");
    expect(retention).toContain('resolve(".eve", ".workflow-data")');
    expect(retention).not.toContain('resolve(".workflow-data")');
  });
});
