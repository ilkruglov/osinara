/**
 * PostgreSQL Workflow session retention adapter tests.
 *
 * Tests:
 * - Rejects malformed and absent Eve run identities.
 * - Refuses a run still being worked on and a hook whose retention window is still open.
 * - Cancels a run parked long after the application retired its conversation, then deletes it.
 * - Deletes every public per-run table atomically before the run row.
 * - Rolls back and preserves the original database failure.
 */
import { describe, expect, it, vi } from "vitest";

import { deletePostgresEveSession } from "./workflow-postgres-session-storage.js";

const runId = "wrun_01M0AZKZAKTGSH4QQZBBCJK63C";

function clientWithRows(rows: Array<Record<string, unknown>[]>) {
  const query = vi.fn(async (_text: string, _values?: readonly unknown[]) => ({
    rowCount: 1,
    rows: rows.shift() ?? [],
  }));
  return { query };
}

describe("deletePostgresEveSession", () => {
  it("rejects a malformed run id before querying PostgreSQL", async () => {
    const client = clientWithRows([]);

    await expect(deletePostgresEveSession("session-1", client)).rejects.toThrowError(
      /AGENT_EVE_SESSION_ID_INVALID/u,
    );
    expect(client.query).not.toHaveBeenCalled();
  });

  it("requires an existing terminal run without retained hooks", async () => {
    const missing = clientWithRows([[], []]);
    await expect(deletePostgresEveSession(runId, missing)).rejects.toThrowError(
      /AGENT_EVE_SESSION_STORAGE_MISSING/u,
    );
    expect(missing.query).toHaveBeenLastCalledWith("ROLLBACK");

    const active = clientWithRows([[], [{ parked: false, status: "running" }], []]);
    await expect(deletePostgresEveSession(runId, active)).rejects.toThrowError(
      /AGENT_EVE_SESSION_STORAGE_ACTIVE/u,
    );
    expect(active.query).toHaveBeenLastCalledWith("ROLLBACK");

    const retainedHook = clientWithRows([[], [{ parked: true, status: "completed" }], [{ exists: true }], []]);
    await expect(deletePostgresEveSession(runId, retainedHook)).rejects.toThrowError(
      /AGENT_EVE_SESSION_HOOK_RETENTION_ACTIVE/u,
    );
    expect(retainedHook.query).toHaveBeenLastCalledWith("ROLLBACK");
  });

  // A parked run waits on a hook nobody will answer: the application retired that conversation a
  // day earlier. Refusing to delete kept the run and the session forever, and every agent start
  // then re-read all of their event logs (36 sessions stuck since 3 сентября 2026).
  it("cancels a run left parked after its conversation was retired", async () => {
    const client = clientWithRows([[], [{ parked: true, status: "running" }], [{ exists: false }]]);

    await expect(deletePostgresEveSession(runId, client)).resolves.toBeUndefined();

    const statements = client.query.mock.calls.map(([sql]) => sql);
    expect(statements.some((sql) => /UPDATE workflow\.workflow_runs/u.test(sql))).toBe(true);
    // Only an open retention window protects a hook; a parked session's hooks carry none.
    expect(statements.some((sql) => /token_retention_until > now\(\)/u.test(sql))).toBe(true);
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("deletes all public per-run records in one transaction", async () => {
    const client = clientWithRows([[], [{ parked: true, status: "failed" }], [{ exists: false }]]);

    await expect(deletePostgresEveSession(runId, client)).resolves.toBeUndefined();

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      expect.stringContaining("FROM workflow.workflow_runs"),
      expect.stringContaining("FROM workflow.workflow_hooks"),
      "DELETE FROM workflow.workflow_stream_chunks WHERE run_id = $1",
      "DELETE FROM workflow.workflow_waits WHERE run_id = $1",
      "DELETE FROM workflow.workflow_hooks WHERE run_id = $1",
      "DELETE FROM workflow.workflow_steps WHERE run_id = $1",
      "DELETE FROM workflow.workflow_events WHERE run_id = $1",
      "DELETE FROM workflow.workflow_event_slots WHERE run_id = $1",
      "DELETE FROM workflow.workflow_runs WHERE id = $1",
      "COMMIT",
    ]);
  });

  it("rolls back and rethrows the original deletion error", async () => {
    const databaseError = new Error("connection lost");
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: null, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: "cancelled" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: false }] })
      .mockRejectedValueOnce(databaseError)
      .mockResolvedValueOnce({ rowCount: null, rows: [] });

    await expect(deletePostgresEveSession(runId, { query })).rejects.toBe(databaseError);
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
  });
});
