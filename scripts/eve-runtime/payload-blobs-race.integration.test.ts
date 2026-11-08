/**
 * Payload blob writes against session deletion, on a real Workflow database.
 *
 * Constructs covered:
 * - A writer's blob, its reference and its event commit together, so deleting another session that
 *   held the last reference cannot remove the blob between the writer's touch and its reference
 *   (Codex review, 6 November 2026: the generic event path wrote them as separate autocommits, and
 *   a cold read then failed with AGENT_WORKFLOW_PAYLOAD_BLOB_MISSING).
 */
import { createHash, randomUUID } from "node:crypto";
import { zstdCompressSync } from "node:zlib";

import pg from "pg";
import { describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { createClient } from "../../node_modules/@workflow/world-postgres/dist/drizzle/index.js";
import {
  createEventsStorage,
  resetPayloadBlobCacheForTest,
} from "../../node_modules/@workflow/world-postgres/dist/storage.js";
import { deletePostgresEveSession } from "../../agent/lib/sessions/workflow-postgres-session-storage.js";

const big = (seed: string) =>
  Array.from({ length: 128 }, (_, i) =>
    createHash("sha256").update(`${seed}${i}`).digest("hex"),
  ).join(" ");
const payload = (flat: unknown[]) =>
  new Uint8Array(
    Buffer.concat([
      Buffer.from("zstd"),
      zstdCompressSync(Buffer.concat([Buffer.from("devl"), Buffer.from(JSON.stringify(flat))])),
    ]),
  );

describe.skipIf(
  process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true" || !process.env.WORKFLOW_POSTGRES_URL,
)("payload blobs and session deletion", () => {
  it("keeps a blob that a concurrent writer references while the last old reference is deleted", async () => {
    process.env.OSINARA_WORKFLOW_PAYLOAD_BLOBS = "1";
    const pool = new pg.Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL, max: 3 });
    const deleter = new pg.Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL, max: 1 });
    const events = createEventsStorage(createClient(pool));
    const shared = big(`shared ${randomUUID()}`);
    const hash = createHash("sha256").update(shared, "utf8").digest("hex");
    const [old, fresh] = [`wrun_${ulid()}`, `wrun_${ulid()}`];
    const created = (runId: string) =>
      events.create(runId, {
        eventData: {
          deploymentId: "blob-race",
          input: payload([{ a: 1 }, "small"]),
          workflowName: "blob-race",
        },
        eventType: "run_created",
      } as never);
    const original = pg.Client.prototype.query;
    try {
      for (const runId of [old, fresh]) {
        await created(runId);
        await events.create(runId, { eventType: "run_started" } as never);
      }
      // The old session holds the only reference to the shared blob and is finished.
      await events.create(old, {
        eventData: { output: payload([{ text: 1 }, shared]) },
        eventType: "run_completed",
      } as never);

      // Pause the writer right before it adds its reference, and delete the old session there.
      let deletion: Promise<void> | undefined;
      pg.Client.prototype.query = function patched(
        this: pg.Client,
        config: unknown,
        ...rest: unknown[]
      ) {
        const text =
          typeof config === "string" ? config : (config as { text?: unknown } | null)?.text;
        if (
          deletion === undefined &&
          typeof text === "string" &&
          /INSERT INTO workflow\.workflow_payload_blob_refs/u.test(text)
        ) {
          deletion = (async () => {
            const client = await deleter.connect();
            try {
              await deletePostgresEveSession(old, client);
            } finally {
              client.release();
            }
          })();
          return new Promise((resolve) => setTimeout(resolve, 500)).then(() =>
            (original as (...args: unknown[]) => unknown).call(this, config, ...rest),
          );
        }
        return (original as (...args: unknown[]) => unknown).call(this, config, ...rest);
      } as typeof original;
      await events.create(fresh, {
        eventData: { output: payload([{ text: 1 }, shared]) },
        eventType: "run_completed",
      } as never);
      pg.Client.prototype.query = original;
      expect(deletion).toBeDefined();
      await deletion;

      const blob = await pool.query(
        "SELECT 1 FROM workflow.workflow_payload_blobs WHERE hash = $1",
        [hash],
      );
      expect(blob.rowCount).toBe(1);
      // A process with nothing cached reads the fresh run's output back.
      resetPayloadBlobCacheForTest();
      const listed = await createEventsStorage(createClient(pool)).list({ runId: fresh } as never);
      expect(
        listed.data.some((event: { eventType: string }) => event.eventType === "run_completed"),
      ).toBe(true);
    } finally {
      pg.Client.prototype.query = original;
      delete process.env.OSINARA_WORKFLOW_PAYLOAD_BLOBS;
      for (const runId of [old, fresh]) {
        for (const table of [
          "workflow_events",
          "workflow_steps",
          "workflow_event_slots",
          "workflow_payload_blob_refs",
          "workflow_runs",
        ]) {
          await pool.query(
            `DELETE FROM workflow.${table} WHERE ${table === "workflow_runs" ? "id" : "run_id"} = $1`,
            [runId],
          );
        }
      }
      await pool.end();
      await deleter.end();
    }
  }, 30_000);
});
