/**
 * Migration 129: the 7-day use-reinforcement rule replayed over the model_used history.
 *
 * Constructs covered:
 * - A record used before 1.6.0 (use_count > 0, reinforcement_count = 0) gets the reinforcements
 *   the current rule would have given: uses within seven days of the last counted one count once.
 * - A record whose count already exceeds the replay (explicit `remember_reinforces`) is left alone.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { createMainAgentMemoryFixture } from "./memory-agent-write.integration-fixtures.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;
if (enabled && (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase("129 use reinforcement backfill", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });
  afterAll(async () => closeDatabase());

  it("replays the weekly rule over past uses and keeps a higher explicit count", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const insert = async (content: string, reinforcementCount: number, lastReinforcedAt: string | null) => {
      const row = await database().query<{ id: string }>(
        `INSERT INTO memory_items_all
           (family_id, scope, kind, content, source, author_user_id, confirmation, sensitivity, operation_key,
            use_count, reinforcement_count, last_reinforced_at)
         VALUES ($1, 'family', 'fact', $2, 'test:129', $3, 'model_high', 'normal', $4, 3, $5, $6)
         RETURNING id`,
        [fixture.familyId, content, fixture.userId, randomUUID(), reinforcementCount, lastReinforcedAt],
      );
      return row.rows[0]!.id;
    };
    const uses = async (id: string, days: readonly number[]) => {
      for (const day of days) {
        await database().query(
          `INSERT INTO memory_reinforcement_events (memory_item_id, eve_session_id, eve_turn_id, reason, created_at)
           VALUES ($1, $2, $3, 'model_used', timestamptz '2026-09-01' + make_interval(days => $4))`,
          [id, randomUUID(), randomUUID(), day],
        );
      }
    };
    // Used on days 0, 3 and 10: day 3 is within the week of day 0, day 10 starts a new one.
    const uncounted = await insert(`Запись ${randomUUID()}`, 0, null);
    await uses(uncounted, [0, 3, 10]);
    // An explicit reinforcement already counted more than the replay gives.
    const explicit = await insert(`Запись ${randomUUID()}`, 5, "2026-09-20T00:00:00Z");
    await uses(explicit, [0]);

    await database().query(await readFile("migrations/129_backfill_use_reinforcement.sql", "utf8"));

    const rows = await database().query<{ id: string; reinforcement_count: number; last_reinforced_at: Date }>(
      "SELECT id, reinforcement_count, last_reinforced_at FROM memory_items_all WHERE id = ANY($1::uuid[]) ORDER BY reinforcement_count",
      [[uncounted, explicit]],
    );
    expect(rows.rows.map((row) => [row.id, row.reinforcement_count, row.last_reinforced_at.toISOString().slice(0, 10)])).toEqual([
      [uncounted, 2, "2026-09-11"],
      [explicit, 5, "2026-09-20"],
    ]);
  });
});
