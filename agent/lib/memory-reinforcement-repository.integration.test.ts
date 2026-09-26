/**
 * Reinforcement repository integration tests.
 *
 * Constructs covered:
 * - A readable active record gains one reinforcement with a fresh timestamp and an audit event.
 * - A ref outside the caller's areas or an unknown ref is reported, never touched.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { createMainAgentMemoryFixture } from "./memory-agent-write.integration-fixtures.js";
import { memoryReinforcementRepository } from "./memory-reinforcement-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase("memoryReinforcementRepository", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE memory_embedding_chunks, memory_embedding_jobs, memory_items_all, family_memberships, users, families CASCADE",
    );
  });
  afterAll(closeDatabase);

  it("records model use once per turn, reinforces once per window, and ignores foreign refs", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const inserted = await database().query<{ id: string }>(
      `INSERT INTO memory_items
         (family_id, author_user_id, author_telegram_user_id, scope, kind, content, source,
          confirmation, sensitivity, operation_key)
       VALUES ($1, $2, 'agent-memory-author', 'family', 'fact', 'Гоша живёт дома', 'test:reinforce',
               'model_high', 'normal', 'op-reinforce-1')
       RETURNING id`,
      [fixture.familyId, fixture.userId],
    );
    const ref = await database().query<{ memory_ref: string }>(
      "SELECT memory_ref FROM memory_item_refs WHERE memory_item_id = $1",
      [inserted.rows[0]!.id],
    );
    const memoryRef = ref.rows[0]!.memory_ref;

    const result = await memoryReinforcementRepository.reinforceByRefs(fixture.auth, {
      memoryRefs: [memoryRef, memoryRef, "mem_00000000000000000000000000000000"],
      provenance: { sessionId: "eve-1", turnId: "turn-1" },
      reason: "model_used",
    });

    expect(result).toEqual({ reinforced: [memoryRef], unknown: ["mem_00000000000000000000000000000000"] });
    await expect(database().query(
      "SELECT reinforcement_count, last_reinforced_at IS NOT NULL AS stamped, use_count, last_used_at IS NOT NULL AS used FROM memory_items WHERE id = $1",
      [inserted.rows[0]!.id],
    )).resolves.toMatchObject({ rows: [{ reinforcement_count: 1, stamped: true, use_count: 1, used: true }] });
    await expect(database().query(
      "SELECT metadata->>'reason' AS reason FROM audit_events WHERE event_type = 'memory.reinforced' AND subject_id = $1",
      [inserted.rows[0]!.id],
    )).resolves.toMatchObject({ rows: [{ reason: "model_used" }] });

    await memoryReinforcementRepository.reinforceByRefs(fixture.auth, {
      memoryRefs: [memoryRef], provenance: { sessionId: "eve-1", turnId: "turn-1" }, reason: "model_used",
    });
    expect((await database().query("SELECT use_count FROM memory_items WHERE id = $1", [inserted.rows[0]!.id])).rows)
      .toEqual([{ use_count: 1 }]);

    // A second use inside the window counts as use, not as reinforcement; past the window it does both.
    await memoryReinforcementRepository.reinforceByRefs(fixture.auth, {
      memoryRefs: [memoryRef], provenance: { sessionId: "eve-1", turnId: "turn-1b" }, reason: "model_used",
    });
    expect((await database().query("SELECT use_count, reinforcement_count FROM memory_items WHERE id = $1", [inserted.rows[0]!.id])).rows)
      .toEqual([{ reinforcement_count: 1, use_count: 2 }]);
    await database().query("UPDATE memory_items SET last_reinforced_at = now() - interval '8 days' WHERE id = $1", [inserted.rows[0]!.id]);
    await memoryReinforcementRepository.reinforceByRefs(fixture.auth, {
      memoryRefs: [memoryRef], provenance: { sessionId: "eve-1", turnId: "turn-1c" }, reason: "model_used",
    });
    expect((await database().query("SELECT use_count, reinforcement_count, last_reinforced_at > now() - interval '1 minute' AS fresh FROM memory_items WHERE id = $1", [inserted.rows[0]!.id])).rows)
      .toEqual([{ fresh: true, reinforcement_count: 2, use_count: 3 }]);

    // A personal-only caller cannot reinforce a family record.
    const personalOnly = { ...fixture.auth, scopes: ["personal" as const] };
    await expect(memoryReinforcementRepository.reinforceByRefs(personalOnly, {
      memoryRefs: [memoryRef], provenance: { sessionId: "eve-1", turnId: "turn-2" }, reason: "model_used",
    })).resolves.toEqual({ reinforced: [], unknown: [memoryRef] });

    // Revoked membership closes reinforcement too: the session's scopes are not a live grant.
    await database().query("DELETE FROM family_memberships WHERE family_id = $1 AND user_id = $2", [fixture.familyId, fixture.userId]);
    await expect(memoryReinforcementRepository.reinforceByRefs(fixture.auth, {
      memoryRefs: [memoryRef], provenance: { sessionId: "eve-1", turnId: "turn-3" }, reason: "model_used",
    })).resolves.toEqual({ reinforced: [], unknown: [memoryRef] });
    await expect(database().query(
      "SELECT reinforcement_count FROM memory_items WHERE id = $1", [inserted.rows[0]!.id],
    )).resolves.toMatchObject({ rows: [{ reinforcement_count: 2 }] });
  });
});
