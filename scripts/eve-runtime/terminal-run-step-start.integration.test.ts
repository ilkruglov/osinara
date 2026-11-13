/**
 * No step starts on a finished run.
 *
 * Constructs covered:
 * - A redelivered `step_started` on a cancelled run is refused even though the step row still
 *   reads `running`: the claim used to pass and the step body ran again for nothing.
 * - The in-flight step can still record its outcome (`step_completed`) on that run.
 *
 * Ported from vercel/workflow 03455a2 (world-postgres beta.42, 13 November 2026); our
 * world-postgres is 5.0.0-beta.35.
 */
import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { createClient } from "../../node_modules/@workflow/world-postgres/dist/drizzle/index.js";
import { createEventsStorage } from "../../node_modules/@workflow/world-postgres/dist/storage.js";

const bytes = (text: string) => new Uint8Array(Buffer.from(text));

describe.skipIf(
  process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true" || !process.env.WORKFLOW_POSTGRES_URL,
)("step start on a finished run", () => {
  it("refuses a redelivered start and still records the running step's outcome", async () => {
    const pool = new Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL, max: 2 });
    const events = createEventsStorage(createClient(pool));
    const runId = `wrun_${ulid()}`;
    const stepId = `step_${randomUUID()}`;
    try {
      await events.create(runId, {
        eventData: { deploymentId: "fence-test", input: bytes("in"), workflowName: "fence-test" },
        eventType: "run_created",
      } as never);
      await events.create(runId, { eventType: "run_started" } as never);
      await events.create(runId, {
        correlationId: stepId,
        eventData: { input: bytes("step in"), stepName: "fencedStep" },
        eventType: "step_created",
      } as never);
      await events.create(runId, {
        correlationId: stepId,
        eventData: { stepName: "fencedStep" },
        eventType: "step_started",
      } as never);
      await events.create(runId, { eventType: "run_cancelled" } as never);

      await expect(
        events.create(runId, {
          correlationId: stepId,
          eventData: { stepName: "fencedStep" },
          eventType: "step_started",
        } as never),
      ).rejects.toThrow(/Cannot start step on run in terminal state/u);
      await expect(
        events.create(runId, {
          correlationId: stepId,
          eventData: { result: bytes("out"), stepName: "fencedStep" },
          eventType: "step_completed",
        } as never),
      ).resolves.toBeDefined();
    } finally {
      await pool.query("DELETE FROM workflow.workflow_runs WHERE id = $1", [runId]);
      await pool.end();
    }
  });
});
