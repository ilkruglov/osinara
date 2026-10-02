/**
 * BERTA embedding migration test.
 *
 * Constructs covered:
 * - Migration 123 keeps every E5 chunk and thread title vector under retired names for rollback.
 * - The new 768-dimension chunk table starts empty and every record, deleted or not, is requeued
 *   with its own creation time.
 * - Thread titles lose their current vector so the embedding worker refills them.
 * - Migration 124 removes the jobs 123 queued for soft-deleted records.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const TEST_SCHEMA = "berta_memory_embeddings_migration_test";
const ITEM = "10000000-0000-4000-8000-000000000001";
const THREAD = "20000000-0000-4000-8000-000000000001";
const HIDDEN = "10000000-0000-4000-8000-000000000002";
const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

describeWithDatabase("BERTA memory embeddings migration", () => {
  afterAll(closeDatabase);

  it("retires E5 vectors and requeues every record", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await client.query(`
        CREATE TABLE memory_items_all (
          id uuid PRIMARY KEY,
          embedding_status text NOT NULL,
          created_at timestamptz NOT NULL,
          deleted_at timestamptz
        );
        CREATE VIEW memory_items AS SELECT * FROM memory_items_all WHERE deleted_at IS NULL;
        CREATE TABLE memory_embedding_jobs (
          memory_item_id uuid PRIMARY KEY REFERENCES memory_items_all(id),
          status text NOT NULL DEFAULT 'pending',
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE memory_embedding_chunks (
          memory_item_id uuid NOT NULL REFERENCES memory_items_all(id) ON DELETE CASCADE,
          chunk_index integer NOT NULL,
          content text NOT NULL,
          start_offset integer NOT NULL,
          end_offset integer NOT NULL,
          embedding vector(384) NOT NULL,
          embedding_model text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (memory_item_id, chunk_index)
        );
        CREATE INDEX memory_embedding_chunks_vector_idx
          ON memory_embedding_chunks USING hnsw (embedding vector_cosine_ops);
        CREATE INDEX memory_embedding_chunks_model_item_idx
          ON memory_embedding_chunks (embedding_model, memory_item_id);
        CREATE TABLE memory_threads (
          id uuid PRIMARY KEY,
          title text NOT NULL,
          title_embedding vector(384),
          title_embedding_model text
        );
      `);
      await client.query(`
        INSERT INTO memory_items_all (id, embedding_status, created_at, deleted_at)
        VALUES ('${ITEM}', 'indexed', '2026-09-01T10:00:00Z', NULL),
               ('${HIDDEN}', 'indexed', '2026-09-02T10:00:00Z', '2026-09-03T10:00:00Z');
        INSERT INTO memory_embedding_jobs (memory_item_id, status) VALUES ('${ITEM}', 'completed');
        INSERT INTO memory_embedding_chunks
          (memory_item_id, chunk_index, content, start_offset, end_offset, embedding, embedding_model)
        VALUES ('${ITEM}', 0, 'факт', 0, 4, array_fill(0.1, ARRAY[384])::vector, 'e5@rev');
        INSERT INTO memory_threads (id, title, title_embedding, title_embedding_model)
        VALUES ('${THREAD}', 'Ремонт', array_fill(0.1, ARRAY[384])::vector, 'e5@rev');
      `);

      await client.query(await readFile(resolve("migrations/123_berta_memory_embeddings.sql"), "utf8"));

      const retired = await client.query(
        "SELECT embedding_model, vector_dims(embedding) AS dims FROM retired_e5_memory_embedding_chunks",
      );
      expect(retired.rows).toEqual([{ dims: 384, embedding_model: "e5@rev" }]);
      expect((await client.query("SELECT count(*)::int AS n FROM memory_embedding_chunks")).rows)
        .toEqual([{ n: 0 }]);
      await expect(client.query(
        `INSERT INTO memory_embedding_chunks
           (memory_item_id, chunk_index, content, start_offset, end_offset, embedding, embedding_model)
         VALUES ('${ITEM}', 0, 'факт', 0, 4, array_fill(0.1, ARRAY[768])::vector, 'berta@rev')`,
      )).resolves.toBeDefined();
      expect((await client.query("SELECT DISTINCT embedding_status FROM memory_items_all")).rows)
        .toEqual([{ embedding_status: "pending" }]);
      expect((await client.query("SELECT count(*)::int AS n FROM memory_embedding_jobs")).rows).toEqual([{ n: 2 }]);

      await client.query(await readFile(resolve("migrations/124_drop_embedding_jobs_of_hidden_records.sql"), "utf8"));
      // Only the visible record keeps its job, with the record's creation time for the newest-first worker.
      expect((await client.query(
        "SELECT memory_item_id, status, created_at = '2026-09-01T10:00:00Z' AS record_time FROM memory_embedding_jobs",
      )).rows).toEqual([{ memory_item_id: ITEM, record_time: true, status: "pending" }]);
      const thread = await client.query(
        `SELECT retired_e5_title_embedding_model, vector_dims(retired_e5_title_embedding) AS dims,
                title_embedding, title_embedding_model
         FROM memory_threads`,
      );
      expect(thread.rows).toEqual([{
        dims: 384,
        retired_e5_title_embedding_model: "e5@rev",
        title_embedding: null,
        title_embedding_model: null,
      }]);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`).catch(() => undefined);
      await client.query("SET search_path TO public");
      client.release();
    }
  });
});
