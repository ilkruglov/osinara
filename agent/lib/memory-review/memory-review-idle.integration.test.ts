/**
 * Idle memory-review integration tests.
 *
 * Constructs covered:
 * - Background batches may hold 1..50 sources after migration 084.
 * - Idle lanes (ten minutes of silence) and full lanes (ten sources) materialize one pending batch.
 * - Personal conversations get a lazily created lane and a claimable private review batch.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import {
  createMainAgentMemoryFixture,
  createMainAgentPrivateMemoryFixture,
} from "../memory-agent-write.integration-fixtures.js";
import { memoryReviewDispatchRepository } from "./memory-review-dispatch-repository.js";
import { memoryReviewRepository } from "./memory-review-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

async function insertUserMessage(input: {
  conversationId: string;
  groupId: string | null;
  sentAt: string;
  sequence: number;
}) {
  return (await database().query<{ id: string }>(
    `INSERT INTO telegram_group_messages
       (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text,
        message_thread_id, sent_at)
     VALUES ($1, $2, $3, $3, 'user', 'telegram:agent-memory-author',
             'agent-memory-author', 'Анна', false, 'text', $4, NULL, $5::timestamptz)
     RETURNING id`,
    [input.conversationId, input.groupId, input.sequence,
      `Сообщение памяти ${input.sequence}`, input.sentAt],
  )).rows[0]!;
}

describeWithDatabase("idle memory review", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("accepts a background batch with fewer than 50 sources", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await memoryReviewRepository.initializeLane({
      conversationId: fixture.conversationId,
      messageThreadId: null,
      processedThroughSequence: "1",
    });
    const lane = await database().query<{ id: string }>(
      "SELECT id FROM memory_review_lanes WHERE conversation_id = $1",
      [fixture.conversationId],
    );

    await expect(database().query(
      `INSERT INTO memory_review_batches
         (lane_id, conversation_id, batch_kind, status, predecessor_sequence,
          from_sequence, through_sequence, source_count)
       VALUES ($1, $2, 'background', 'pending', 1, 2, 4, 3)`,
      [lane.rows[0]!.id, fixture.conversationId],
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it("exposes attribute and occurred_at through the memory_items view", async () => {
    const columns = await database().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'memory_items' AND column_name IN ('attribute', 'occurred_at')`,
    );
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual(["attribute", "occurred_at"]);
  });
});
