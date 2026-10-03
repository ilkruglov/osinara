/**
 * A run's slot marker and its run_created event become visible together with the run row.
 *
 * Constructs covered:
 * - A run_started that arrives while start() is still writing run_created never mints a legacy
 *   `wevt_` id: every event of the run is slot-numbered and run_created holds the first slot.
 *
 * The load run of 3 October 2026 (10 000 families, 8 replicas) left 59 turn runs at run_created:
 * the queue's run_started read the run row between its insert and the slot marker, took a ULID,
 * and every replay then failed with "Event id is not slot-numbered".
 */
import { setTimeout as sleep } from "node:timers/promises";

import { Pool, type PoolClient, type QueryConfig } from "pg";
import { describe, expect, it } from "vitest";

import { createClient } from "../../node_modules/@workflow/world-postgres/dist/drizzle/index.js";
import { createEventsStorage } from "../../node_modules/@workflow/world-postgres/dist/storage.js";
import { eventIdToSlot, FIRST_EVENT_SLOT } from "../../node_modules/@workflow/world/dist/slot-identity.js";
import { ulid } from "ulid";

type Query = (config: string | QueryConfig, ...rest: unknown[]) => Promise<unknown>;

const textOf = (config: unknown) => typeof config === "string" ? config : (config as { text?: string }).text ?? "";

/** Calls `after` once a query whose text matches `pattern` has returned, on the pool or on a transaction client. */
function hookQuery(pool: Pool, pattern: RegExp, after: () => Promise<void>) {
  const wrap = (query: Query): Query => async (config, ...rest) => {
    const result = await query(config, ...rest);
    if (pattern.test(textOf(config))) await after();
    return result;
  };
  pool.query = wrap(pool.query.bind(pool) as Query) as typeof pool.query;
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => Promise<PoolClient> | undefined;
  // `Pool.query` itself checks out a client with a callback; only a transaction asks for a promise.
  pool.connect = ((...args: unknown[]) => {
    if (args.length > 0) return connect(...args);
    return connect()!.then((client) => {
      client.query = wrap(client.query.bind(client) as Query) as typeof client.query;
      return client;
    });
  }) as typeof pool.connect;
}

describe.skipIf(process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true" || !process.env.WORKFLOW_POSTGRES_URL)("run creation and slot numbering", () => {
  it("numbers a run_started that races run_created", async () => {
    if (!process.env.WORKFLOW_POSTGRES_URL) throw new Error("TEST_WORKFLOW_DATABASE_MISSING");
    const creator = new Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL, max: 2 });
    const starter = new Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL, max: 2 });
    const runId = `wrun_${ulid()}`;
    const eventData = { deploymentId: "race-test", input: new Uint8Array([1]), workflowName: "race-test" };
    const startingStorage = createEventsStorage(createClient(starter));
    let racing: Promise<unknown> | undefined;
    hookQuery(creator, /^insert into "workflow"\."workflow_runs"/u, async () => {
      if (racing) return;
      // The queue's resilient start: run_started carries the run input in case start() failed.
      racing = startingStorage.create(runId, { eventData, eventType: "run_started", specVersion: undefined } as never);
      racing.catch(() => undefined);
      await sleep(300);
    });
    try {
      await createEventsStorage(createClient(creator)).create(runId, { eventData, eventType: "run_created" } as never);
      await racing;
      const { rows } = await creator.query<{ event_id: string; type: string }>(
        `SELECT id AS event_id, type FROM workflow.workflow_events WHERE run_id = $1 ORDER BY id`,
        [runId],
      );
      expect(rows.map((row) => row.type)).toEqual(["run_created", "run_started"]);
      expect(rows.map((row) => eventIdToSlot(row.event_id))).toEqual([FIRST_EVENT_SLOT, FIRST_EVENT_SLOT + 1]);
    } finally {
      await creator.query("DELETE FROM workflow.workflow_events WHERE run_id = $1", [runId]);
      await creator.query("DELETE FROM workflow.workflow_event_slots WHERE run_id = $1", [runId]);
      await creator.query("DELETE FROM workflow.workflow_runs WHERE id = $1", [runId]);
      await Promise.all([creator.end(), starter.end()]);
    }
  });
});
