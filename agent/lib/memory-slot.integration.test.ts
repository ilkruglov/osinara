/**
 * Memory slot integration tests.
 *
 * Constructs covered:
 * - A profile claim persists its attribute slot.
 * - A newer claim in the same subject slot supersedes the older one and keeps it as a version.
 * - An identical claim in the slot is reinforced, not duplicated.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { createMainAgentMemoryFixture } from "./memory-agent-write.integration-fixtures.js";
import type { CreateMemoryInput } from "./memory-record.js";
import { memoryRepository } from "./memory-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

function slotInput(
  fixture: { conversationId: string; timelineEntryId: string },
  content: string,
  operationKey: string,
): CreateMemoryInput {
  return {
    attribute: "работа",
    confirmation: "model_high",
    content,
    explicitSource: {
      conversationId: fixture.conversationId,
      subject: { kind: "current_author" },
      timelineEntryId: fixture.timelineEntryId,
    },
    kind: "profile",
    operationKey,
    provenance: { sessionId: "eve-session-slot", turnId: `eve-turn-${operationKey}` },
    scope: "family",
    sensitivity: "normal",
    source: `eve:eve-session-slot:eve-turn-${operationKey}`,
  };
}

describeWithDatabase("memory slots", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("persists the attribute slot of a profile claim", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const memory = await memoryRepository.create(
      fixture.auth,
      slotInput(fixture, "Анна работает логистом", "slot-1"),
    );

    await expect(database().query(
      "SELECT attribute FROM memory_items WHERE id = $1",
      [memory.id],
    )).resolves.toMatchObject({ rows: [{ attribute: "работа" }] });
  });

  it("supersedes the previous claim in the same subject slot", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const first = await memoryRepository.create(
      fixture.auth,
      slotInput(fixture, "Анна работает логистом", "slot-a"),
    );
    const second = await memoryRepository.create(
      fixture.auth,
      slotInput(fixture, "Анна ушла в IT, теперь тестировщик", "slot-b"),
    );

    await expect(database().query(
      "SELECT claim_status::text, superseded_by FROM memory_items_all WHERE id = $1",
      [first.id],
    )).resolves.toMatchObject({ rows: [{ claim_status: "superseded", superseded_by: second.id }] });
    await expect(database().query(
      `SELECT relation_type::text, detection_method, detection_metadata->>'method' AS method
         FROM claim_relations WHERE source_claim_id = $1 AND target_claim_id = $2`,
      [first.id, second.id],
    )).resolves.toMatchObject({
      rows: [{ detection_method: "deterministic_exact", method: "slot_attribute", relation_type: "temporal_update" }],
    });
    const active = await database().query<{ id: string }>(
      `SELECT id FROM memory_items WHERE family_id = $1 AND scope = 'family'
        AND claim_status = 'active'`,
      [fixture.familyId],
    );
    expect(active.rows.map((row) => row.id)).toEqual([second.id]);
  });

  it("reinforces an identical claim in the slot instead of creating a version", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const first = await memoryRepository.create(
      fixture.auth,
      slotInput(fixture, "Анна работает логистом", "slot-c"),
    );
    const again = await memoryRepository.create(
      fixture.auth,
      slotInput(fixture, "Анна работает логистом", "slot-d"),
    );

    expect(again.id).toBe(first.id);
    await expect(database().query(
      "SELECT claim_status::text, reinforcement_count FROM memory_items WHERE id = $1",
      [first.id],
    )).resolves.toMatchObject({ rows: [{ claim_status: "active", reinforcement_count: 1 }] });
  });
});
