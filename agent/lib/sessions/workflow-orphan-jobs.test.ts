/**
 * Orphan Workflow queue job release tests.
 *
 * Tests:
 * - A job older than the grace period whose run row is gone is completed through Graphile's public
 *   `complete_jobs`; a job of a live run is kept.
 * - A first delivery carrying `runInput` is kept even without a run row: the consumer creates the
 *   run from it. Payloads that do not decode to a run id are kept as well.
 * - Nothing to release means no `complete_jobs` call.
 * - A full page hands its last id on as the next cursor, a short page starts over.
 */
import { describe, expect, it, vi } from "vitest";

import { releaseOrphanWorkflowJobs } from "./workflow-orphan-jobs.js";

function payload(body: Record<string, unknown>) {
  // `payload->>'data'` of world-postgres MessageData: the queue body in base64.
  return Buffer.from(JSON.stringify(body)).toString("base64");
}

function client(jobs: Array<{ id: string; data: string | null }>, liveRuns: string[]) {
  const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
    if (text.includes("_private_jobs")) return { rowCount: jobs.length, rows: jobs };
    if (text.includes("workflow.workflow_runs")) {
      const asked = (values?.[0] ?? []) as string[];
      const rows = asked.filter((id) => liveRuns.includes(id)).map((id) => ({ id }));
      return { rowCount: rows.length, rows };
    }
    if (text.includes("complete_jobs")) {
      const ids = (values?.[0] ?? []) as string[];
      return { rowCount: ids.length, rows: ids.map((id) => ({ id })) };
    }
    throw new Error(`unexpected query: ${text}`);
  });
  return { query };
}

describe("releaseOrphanWorkflowJobs", () => {
  it("completes old jobs whose run is gone and keeps the rest", async () => {
    const c = client(
      [
        { id: "1", data: payload({ runId: "wrun_GONE" }) },
        { id: "2", data: payload({ runId: "wrun_LIVE" }) },
        { id: "3", data: payload({ runId: "wrun_NEW", runInput: { input: [] } }) },
        { id: "4", data: "not base64 json" },
        { id: "6", data: null },
        { id: "5", data: payload({ runId: "wrun_GONE", stepId: "step_1" }) },
      ],
      ["wrun_LIVE"],
    );
    expect(await releaseOrphanWorkflowJobs(c)).toEqual({ released: 2, nextAfterId: "0" });

    const [selectText, selectValues] = c.query.mock.calls[0]!;
    expect(selectText).toContain("graphile_worker._private_jobs");
    expect(selectText).toContain("make_interval(mins => $1::int)");
    expect(selectText).toContain("j.id > $2::bigint");
    // The numeric column, not the text output alias: the cursor compares numbers.
    expect(selectText).toMatch(/ORDER BY j\.id\s/u);
    expect(selectValues).toEqual([10, "0", 1000]);
    expect(c.query.mock.calls[1]![1]).toEqual([["wrun_GONE", "wrun_LIVE"]]);
    const [completeText, completeValues] = c.query.mock.calls[2]!;
    expect(completeText).toContain("graphile_worker.complete_jobs($1::bigint[])");
    expect(completeValues).toEqual([["1", "5"]]);
  });

  it("does nothing when every job has its run", async () => {
    const c = client([{ id: "1", data: payload({ runId: "wrun_LIVE" }) }], ["wrun_LIVE"]);
    expect(await releaseOrphanWorkflowJobs(c)).toEqual({ released: 0, nextAfterId: "0" });
    expect(c.query.mock.calls.some(([text]) => text.includes("complete_jobs"))).toBe(false);
  });

  it("continues after a full page and starts over after a short one", async () => {
    const full = client([{ id: "7", data: null }, { id: "9", data: null }], []);
    expect(await releaseOrphanWorkflowJobs(full, { afterId: "3", limit: 2 })).toEqual({ released: 0, nextAfterId: "9" });
    expect(full.query.mock.calls[0]![1]).toEqual([10, "3", 2]);
    const short = client([{ id: "12", data: null }], []);
    expect(await releaseOrphanWorkflowJobs(short, { afterId: "9", limit: 2 })).toEqual({ released: 0, nextAfterId: "0" });
  });
});
