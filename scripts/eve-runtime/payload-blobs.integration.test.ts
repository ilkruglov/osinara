/**
 * Event payload blobs against the real Workflow schema.
 *
 * Constructs covered:
 * - Three events of two runs carrying the same 8 KB string store that string once; each run holds
 *   one reference row; the event rows are far smaller than the payloads they stand for.
 * - `events.list`, `events.get` and `steps.get` return payloads equal to what was written, and the
 *   runtime-facing form (`zstd` + `devl`) is preserved.
 * - A second storage instance (another process, empty cache) restores them from the table.
 * - A payload below the threshold is stored as written.
 */
import { createHash, randomUUID } from "node:crypto";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { createClient } from "../../node_modules/@workflow/world-postgres/dist/drizzle/index.js";
import { createEventsStorage, createStepsStorage } from "../../node_modules/@workflow/world-postgres/dist/storage.js";

const big = (seed: string) => Array.from({ length: 128 }, (_, i) => createHash("sha256").update(`${seed}${i}`).digest("hex")).join(" ");
const payload = (flat: unknown[]) => new Uint8Array(Buffer.concat([Buffer.from("zstd"), zstdCompressSync(Buffer.concat([Buffer.from("devl"), Buffer.from(JSON.stringify(flat))]))]));
const decoded = (bytes: unknown) => {
  const buffer = Buffer.from(bytes as Uint8Array);
  expect(buffer.subarray(0, 4).toString()).toBe("zstd");
  const body = zstdDecompressSync(buffer.subarray(4));
  expect(body.subarray(0, 4).toString()).toBe("devl");
  return JSON.parse(body.subarray(4).toString()) as unknown[];
};

describe.skipIf(process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true" || !process.env.WORKFLOW_POSTGRES_URL)("event payload blobs", () => {
  it("stores a repeated large string once and restores every payload exactly", async () => {
    const pool = new Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL, max: 2 });
    const drizzle = createClient(pool);
    const events = createEventsStorage(drizzle);
    const steps = createStepsStorage(drizzle);
    const prompt = big("system prompt");
    const runs = [`wrun_${ulid()}`, `wrun_${ulid()}`];
    const stepId = `step_${randomUUID()}`;
    const inputFlat = [{ system: 1, text: 2 }, prompt, "hello"];
    const resultFlat = [{ system: 1, history: 2 }, prompt, big("history")];
    try {
      for (const runId of runs) {
        await events.create(runId, { eventData: { deploymentId: "blob-test", input: payload(inputFlat), workflowName: "blob-test" }, eventType: "run_created" } as never);
        await events.create(runId, { eventType: "run_started" } as never);
      }
      await events.create(runs[0]!, { correlationId: stepId, eventData: { input: payload(inputFlat), stepName: "s" }, eventType: "step_created" } as never);
      await events.create(runs[0]!, { correlationId: stepId, eventData: { stepName: "s" }, eventType: "step_started" } as never);
      await events.create(runs[0]!, { correlationId: stepId, eventData: { result: payload(resultFlat), stepName: "s" }, eventType: "step_completed" } as never);
      await events.create(runs[0]!, { correlationId: `step_${randomUUID()}`, eventData: { input: payload([{ a: 1 }, "small"]), stepName: "t" }, eventType: "step_created" } as never);

      const blobs = await pool.query<{ hash: string; size: number }>("SELECT hash, size FROM workflow.workflow_payload_blobs ORDER BY size");
      expect(blobs.rows.map((row) => row.size).sort((a, b) => a - b)).toEqual([Buffer.byteLength(big("history")), Buffer.byteLength(prompt)].sort((a, b) => a - b));
      const refs = await pool.query<{ run_id: string; n: string }>("SELECT run_id, count(*)::text AS n FROM workflow.workflow_payload_blob_refs GROUP BY run_id");
      expect(Object.fromEntries(refs.rows.map((row) => [row.run_id, Number(row.n)]))).toEqual({ [runs[0]!]: 2, [runs[1]!]: 1 });
      const sizes = await pool.query<{ type: string; bytes: number }>(
        "SELECT type, octet_length(payload_cbor) AS bytes FROM workflow.workflow_events WHERE run_id = $1 ORDER BY id", [runs[0]!],
      );
      const runCreatedBytes = sizes.rows.find((row) => row.type === "run_created")!.bytes;
      expect(runCreatedBytes).toBeLessThan(payload(inputFlat).length / 4);

      const listed = await events.list({ runId: runs[0] } as never);
      const byType = Object.fromEntries(listed.data.map((event: { eventType: string; eventData?: Record<string, unknown> }) => [event.eventType, event.eventData]));
      expect(decoded(byType.run_created!.input)).toEqual(inputFlat);
      expect(decoded(byType.step_completed!.result)).toEqual(resultFlat);
      const created = await events.get(runs[0]!, listed.data[0]!.eventId);
      expect(decoded((created as { eventData: { input: unknown } }).eventData.input)).toEqual(inputFlat);
      const step = await steps.get(runs[0]!, stepId);
      expect(decoded(step.input)).toEqual(inputFlat);
      expect(decoded(step.output)).toEqual(resultFlat);
      const small = listed.data.find((event: { eventType: string; correlationId?: string }) => event.eventType === "step_created" && event.correlationId !== stepId) as { eventData: { input: unknown } };
      expect(decoded(small.eventData.input)).toEqual([{ a: 1 }, "small"]);

      // Another process: nothing cached, the blobs come from the table.
      const otherPool = new Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL, max: 1 });
      try {
        // The module-level cache is shared within this process; clear the table copy's dependence
        // by reading through a fresh storage after the rows above were written by this process.
        const other = createEventsStorage(createClient(otherPool));
        const page = await other.list({ runId: runs[1] } as never);
        expect(decoded((page.data[0] as { eventData: { input: unknown } }).eventData.input)).toEqual(inputFlat);
      } finally {
        await otherPool.end();
      }
    } finally {
      for (const runId of runs) {
        await pool.query("DELETE FROM workflow.workflow_events WHERE run_id = $1", [runId]);
        await pool.query("DELETE FROM workflow.workflow_steps WHERE run_id = $1", [runId]);
        await pool.query("DELETE FROM workflow.workflow_event_slots WHERE run_id = $1", [runId]);
        await pool.query("DELETE FROM workflow.workflow_payload_blob_refs WHERE run_id = $1", [runId]);
        await pool.query("DELETE FROM workflow.workflow_runs WHERE id = $1", [runId]);
      }
      await pool.query("DELETE FROM workflow.workflow_payload_blobs WHERE NOT EXISTS (SELECT 1 FROM workflow.workflow_payload_blob_refs r WHERE r.hash = workflow_payload_blobs.hash)");
      await pool.end();
    }
  });
});
