/** Real migration over historical use/evidence rows, isolated in a rolled-back schema. */
import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { closeDatabase, database } from "./database.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) throw new Error("AGENT_TEST_DATABASE_UNSAFE");
afterAll(closeDatabase);

(enabled ? describe : describe.skip)("memory use migration", () => {
  it("preserves claims, separates historical model reuse and makes old turns replay-safe", async () => {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await client.query("CREATE SCHEMA test_memory_use_migration");
      await client.query("SET LOCAL search_path TO test_memory_use_migration, public");
      await client.query(`CREATE TABLE memory_items_all (
        id uuid PRIMARY KEY, content text, deleted_at timestamptz,
        reinforcement_count integer NOT NULL, last_reinforced_at timestamptz,
        CHECK ((reinforcement_count = 0 AND last_reinforced_at IS NULL) OR (reinforcement_count > 0 AND last_reinforced_at IS NOT NULL))
      );
      CREATE TABLE audit_events (subject_id uuid, event_type text, metadata jsonb, created_at timestamptz);
      CREATE VIEW memory_items AS SELECT * FROM memory_items_all WHERE deleted_at IS NULL;
      INSERT INTO memory_items_all VALUES
        ('11111111-1111-4111-8111-111111111111', 'Полный исходный факт', NULL, 3, '2026-09-14'),
        ('22222222-2222-4222-8222-222222222222', 'Удалённый факт', '2026-09-13', 1, '2026-09-14');
      INSERT INTO audit_events VALUES
        ('11111111-1111-4111-8111-111111111111', 'memory.reinforced', '{"reason":"remember_reinforces","sessionId":"s","turnId":"t1"}', '2026-09-01'),
        ('11111111-1111-4111-8111-111111111111', 'memory.reinforced', '{"reason":"model_used","sessionId":"s","turnId":"t2"}', '2026-09-13'),
        ('11111111-1111-4111-8111-111111111111', 'memory.reinforced', '{"reason":"model_used","sessionId":"s","turnId":"t3"}', '2026-09-14'),
        ('22222222-2222-4222-8222-222222222222', 'memory.reinforced', '{"reason":"model_used","sessionId":"s","turnId":"t4"}', '2026-09-14');`);
      await client.query(await readFile(new URL("../../migrations/106_memory_use_signals.sql", import.meta.url), "utf8"));
      const rows = await client.query(`SELECT content, reinforcement_count, use_count,
        last_reinforced_at::date::text AS evidenced, last_used_at::date::text AS used
        FROM memory_items_all ORDER BY id`);
      expect(rows.rows).toEqual([
        { content: "Полный исходный факт", reinforcement_count: 1, use_count: 2, evidenced: "2026-09-01", used: "2026-09-14" },
        { content: "Удалённый факт", reinforcement_count: 0, use_count: 1, evidenced: null, used: "2026-09-14" },
      ]);
      expect((await client.query("SELECT * FROM memory_items")).rowCount).toBe(1);
      expect((await client.query(`INSERT INTO memory_reinforcement_events (memory_item_id, eve_session_id, eve_turn_id, reason)
        VALUES ('11111111-1111-4111-8111-111111111111', 's', 't3', 'model_used') ON CONFLICT DO NOTHING RETURNING *`)).rowCount).toBe(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
