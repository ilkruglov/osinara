/** Stuck Workflow run detection against the real workflow schema in the Compose test database. */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { findInFlightRuns, findStuckRuns, requeueInFlightRuns } from "./stuck-run-recovery.ts";

const LIMITS = { retryAfterMs: 10 * 60 * 1000, stepStartedAfterMs: 25 * 60 * 1000 };

describe.skipIf(process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true" || !process.env.WORKFLOW_POSTGRES_URL)("stuck run recovery", () => {
  // 1 October 2026: the turn run's last event was a retry from 20:32, no job existed for it, and
  // the private chat stayed silent until a restart re-enqueued every active run.
  it("finds runs whose retry or step start was never followed up, and nothing else", async () => {
    if (!process.env.WORKFLOW_POSTGRES_URL) throw new Error("TEST_WORKFLOW_DATABASE_MISSING");
    const pool = new Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL, max: 2 });
    const prefix = `stuck-${randomUUID().slice(0, 8)}`;
    const runs = {
      freshRetry: { last: "step_retrying", minutesAgo: 2, status: "running" },
      lostRetry: { last: "step_retrying", minutesAgo: 30, status: "running" },
      lostStart: { last: "step_started", minutesAgo: 40, status: "running" },
      longStart: { last: "step_started", minutesAgo: 15, status: "running" },
      parked: { last: "hook_created", minutesAgo: 600, status: "running" },
      finished: { last: "step_retrying", minutesAgo: 30, status: "completed" },
    } as const;
    try {
      for (const [name, run] of Object.entries(runs)) {
        const runId = `${prefix}-${name}`;
        await pool.query(
          "INSERT INTO workflow.workflow_runs (id, deployment_id, status, name) VALUES ($1, 'postgres', $2, 'workflow//eve//turnWorkflow')",
          [runId, run.status],
        );
        await pool.query(
          `INSERT INTO workflow.workflow_events (id, type, run_id, created_at)
           VALUES ($1, 'run_created', $2, LOCALTIMESTAMP - make_interval(mins => $3::int + 1)),
                  ($4, $5, $2, LOCALTIMESTAMP - make_interval(mins => $3::int))`,
          [`${runId}-a`, runId, run.minutesAgo, `${runId}-b`, run.last],
        );
      }

      const found = (await findStuckRuns(pool, LIMITS)).filter((run) => run.runId.startsWith(prefix));
      expect(found.map((run) => run.runId.slice(prefix.length + 1)).sort()).toEqual(["lostRetry", "lostStart"]);
      expect(found.every((run) => run.workflowName === "workflow//eve//turnWorkflow")).toBe(true);
    } finally {
      await pool.query("DELETE FROM workflow.workflow_events WHERE run_id LIKE $1", [`${prefix}-%`]);
      await pool.query("DELETE FROM workflow.workflow_runs WHERE id LIKE $1", [`${prefix}-%`]);
      await pool.end();
    }
  }, 15_000);

  // Startup used to re-enqueue every active run, so each parked session replayed its whole log on
  // every deploy (79 runs on production, 4 October 2026); only interrupted runs need that.
  it("names the runs interrupted mid-flight and leaves parked sessions and sleeps alone", async () => {
    if (!process.env.WORKFLOW_POSTGRES_URL) throw new Error("TEST_WORKFLOW_DATABASE_MISSING");
    const pool = new Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL, max: 2 });
    const prefix = `inflight-${randomUUID().slice(0, 8)}`;
    const runs = {
      justStarted: { last: "step_started", minutesAgo: 0, status: "running" },
      betweenSteps: { last: "step_completed", minutesAgo: 1, status: "running" },
      retrying: { last: "step_retrying", minutesAgo: 1, status: "pending" },
      hookArrived: { last: "hook_received", minutesAgo: 1, status: "running" },
      created: { last: "run_created", minutesAgo: 1, status: "pending" },
      parked: { last: "hook_created", minutesAgo: 1, status: "running" },
      sleeping: { last: "wait_created", minutesAgo: 1, status: "running" },
      finished: { last: "step_completed", minutesAgo: 1, status: "completed" },
    } as const;
    try {
      for (const [name, run] of Object.entries(runs)) {
        const runId = `${prefix}-${name}`;
        await pool.query(
          "INSERT INTO workflow.workflow_runs (id, deployment_id, status, name) VALUES ($1, 'postgres', $2, 'workflow//eve//turnWorkflow')",
          [runId, run.status],
        );
        await pool.query(
          `INSERT INTO workflow.workflow_events (id, type, run_id, created_at)
           VALUES ($1, 'run_created', $2, LOCALTIMESTAMP - make_interval(mins => $3::int + 1)),
                  ($4, $5, $2, LOCALTIMESTAMP - make_interval(mins => $3::int))`,
          [`${runId}-a`, runId, run.minutesAgo, `${runId}-b`, run.last],
        );
      }

      const found = (await findInFlightRuns(pool, 3)).filter((run) => run.runId.startsWith(prefix));
      expect(found.map((run) => run.runId.slice(prefix.length + 1)).sort())
        .toEqual(["betweenSteps", "created", "hookArrived", "justStarted", "retrying"]);
      const enqueued: string[] = [];
      await requeueInFlightRuns({
        enqueue: async (queueName, message) => { enqueued.push(`${queueName}|${message.runId}`); },
        pool,
        queuePrefix: "test//",
      });
      expect(enqueued.filter((entry) => entry.includes(prefix)).sort())
        .toEqual(["betweenSteps", "created", "hookArrived", "justStarted", "retrying"].map((name) => `test//workflow//eve//turnWorkflow|${prefix}-${name}`));
    } finally {
      await pool.query("DELETE FROM workflow.workflow_events WHERE run_id LIKE $1", [`${prefix}-%`]);
      await pool.query("DELETE FROM workflow.workflow_runs WHERE id LIKE $1", [`${prefix}-%`]);
      await pool.end();
    }
  }, 15_000);
});
