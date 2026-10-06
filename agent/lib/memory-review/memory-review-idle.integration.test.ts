/**
 * Idle memory-review integration tests.
 *
 * Constructs covered:
 * - Background batches may hold 1..50 sources after migration 084.
 * - Full lanes (ten sources) materialize at once; idle lanes (ten minutes of silence) need at
 *   least five sources, and a long-idle lane (six hours) flushes whatever it holds.
 * - The review prompt carries already processed messages before the batch as read-only context.
 * - Personal conversations get a lazily created lane and a claimable private review batch.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import {
  createMainAgentMemoryFixture,
  createMainAgentPrivateMemoryFixture,
} from "../memory-agent-write.integration-fixtures.js";
import { memoryReviewDispatchRepository } from "./memory-review-dispatch-repository.js";
import { memoryRepository } from "../memory-repository.js";
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
        telegram_user_id, sender_display_name, sender_username, sender_is_bot, message_kind, content_text,
        message_thread_id, sent_at)
     VALUES ($1, $2, $3, $3, 'user', 'telegram:agent-memory-author',
             'agent-memory-author', 'Анна', 'agent_memory_author', false, 'text', $4, NULL, $5::timestamptz)
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

  it("materializes one pending batch for a group lane with five sources silent for ten minutes", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await memoryReviewRepository.initializeLane({
      conversationId: fixture.conversationId,
      messageThreadId: null,
      processedThroughSequence: "1",
    });
    const stale = "2026-09-03T10:00:00.000Z";
    for (const sequence of [2, 3, 4, 5, 6]) {
      await insertUserMessage({
        conversationId: fixture.conversationId, groupId: fixture.groupId, sentAt: stale, sequence,
      });
    }

    const claims = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 10,
      now: new Date("2026-09-03T10:10:00.000Z"),
    });

    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      groupId: fixture.groupId,
      sourceCount: 5,
      throughSequence: "6",
    });
    expect(claims[0]!.entries.map((entry) => entry.sequenceId)).toEqual(["2", "3", "4", "5", "6"]);
  });

  it("keeps a short idle tail waiting until the long idle window flushes it", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await memoryReviewRepository.initializeLane({
      conversationId: fixture.conversationId,
      messageThreadId: null,
      processedThroughSequence: "1",
    });
    for (const sequence of [2, 3, 4]) {
      await insertUserMessage({
        conversationId: fixture.conversationId, groupId: fixture.groupId,
        sentAt: "2026-09-03T10:00:00.000Z", sequence,
      });
    }

    const early = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000, limit: 10, now: new Date("2026-09-03T10:30:00.000Z"),
    });
    expect(early).toHaveLength(0);

    const late = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000, limit: 10, now: new Date("2026-09-03T16:00:01.000Z"),
    });
    expect(late).toHaveLength(1);
    expect(late[0]!.sourceCount).toBe(3);
  });

  it("gives the review the processed messages before the batch as read-only context", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await memoryReviewRepository.initializeLane({
      conversationId: fixture.conversationId,
      messageThreadId: null,
      processedThroughSequence: "3",
    });
    for (const sequence of [2, 3]) {
      await insertUserMessage({
        conversationId: fixture.conversationId, groupId: fixture.groupId,
        sentAt: "2026-09-03T09:00:00.000Z", sequence,
      });
    }
    for (const sequence of [4, 5, 6, 7, 8]) {
      await insertUserMessage({
        conversationId: fixture.conversationId, groupId: fixture.groupId,
        sentAt: "2026-09-03T09:30:00.000Z", sequence,
      });
    }

    const claims = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000, limit: 10, now: new Date("2026-09-03T10:00:00.000Z"),
    });

    expect(claims).toHaveLength(1);
    const prompt = claims[0]!.prompt;
    expect(claims[0]!.entries.map((entry) => entry.sequenceId)).toEqual(["4", "5", "6", "7", "8"]);
    expect(prompt).toContain("<preceding_context>");
    expect(prompt.indexOf("<preceding_context>")).toBeLessThan(prompt.indexOf("<untrusted_memory_review_batch>"));
    const preceding = prompt.slice(prompt.indexOf("<preceding_context>"), prompt.indexOf("</preceding_context>"));
    expect(preceding).toContain("Сообщение памяти 2");
    expect(preceding).toContain("Сообщение памяти 3");
    expect(preceding).not.toContain("Сообщение памяти 4");
  });

  it("waits while the newest unprocessed message is younger than the idle window", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await memoryReviewRepository.initializeLane({
      conversationId: fixture.conversationId,
      messageThreadId: null,
      processedThroughSequence: "1",
    });
    await insertUserMessage({
      conversationId: fixture.conversationId, groupId: fixture.groupId,
      sentAt: "2026-09-03T10:05:00.000Z", sequence: 2,
    });

    const claims = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 10,
      now: new Date("2026-09-03T10:10:00.000Z"),
    });

    expect(claims).toHaveLength(0);
  });

  it("materializes a batch as soon as ten fresh sources accumulate", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await memoryReviewRepository.initializeLane({
      conversationId: fixture.conversationId,
      messageThreadId: null,
      processedThroughSequence: "1",
    });
    for (let sequence = 2; sequence <= 11; sequence += 1) {
      await insertUserMessage({
        conversationId: fixture.conversationId, groupId: fixture.groupId,
        sentAt: "2026-09-03T10:09:30.000Z", sequence,
      });
    }

    const claims = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 10,
      now: new Date("2026-09-03T10:10:00.000Z"),
    });

    expect(claims).toHaveLength(1);
    expect(claims[0]!.sourceCount).toBe(10);
  });

  it("does not materialize a second batch while the lane predecessor is unresolved", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await memoryReviewRepository.initializeLane({
      conversationId: fixture.conversationId,
      messageThreadId: null,
      processedThroughSequence: "1",
    });
    await insertUserMessage({
      conversationId: fixture.conversationId, groupId: fixture.groupId,
      sentAt: "2026-09-03T09:00:00.000Z", sequence: 2,
    });
    await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000, limit: 10, now: new Date("2026-09-03T16:00:00.000Z"),
    });
    await insertUserMessage({
      conversationId: fixture.conversationId, groupId: fixture.groupId,
      sentAt: "2026-09-03T09:30:00.000Z", sequence: 3,
    });
    await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000, limit: 10, now: new Date("2026-09-03T17:00:00.000Z"),
    });

    const batches = await database().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM memory_review_batches WHERE conversation_id = $1",
      [fixture.conversationId],
    );
    expect(batches.rows[0]!.count).toBe("1");
  });

  it("claims a personal conversation batch sponsored by the conversation owner", async () => {
    const fixture = await createMainAgentPrivateMemoryFixture();
    for (const sequence of [2, 3]) {
      await insertUserMessage({
        conversationId: fixture.conversationId, groupId: null,
        sentAt: "2026-09-03T09:00:00.000Z", sequence,
      });
    }

    const claims = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 10,
      now: new Date("2026-09-03T16:00:00.000Z"),
    });

    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      conversationId: fixture.conversationId,
      groupId: null,
      groupType: null,
      memoryScopes: ["personal"],
      ownerUserId: fixture.userId,
      role: "owner",
      scope: "personal",
      sourceCount: 3,
      telegramChatType: "private",
      toolAllowlist: [],
    });
    expect(claims[0]!.entries.map((entry) => entry.sequenceId)).toEqual(["1", "2", "3"]);
  });

  it("shows already stored claims of the conversation to the review", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await memoryRepository.create(fixture.auth, {
      attribute: "работа",
      confirmation: "model_high",
      content: "Анна работает логистом",
      explicitSource: {
        conversationId: fixture.conversationId,
        subject: { kind: "current_author" },
        timelineEntryId: fixture.timelineEntryId,
      },
      kind: "profile",
      operationKey: "review-context-1",
      provenance: { sessionId: "eve-session-ctx", turnId: "eve-turn-ctx" },
      scope: "family",
      sensitivity: "normal",
      source: "eve:eve-session-ctx:eve-turn-ctx",
    });
    for (const [label, content] of [["Анна (agent_memory_author)", "Ездит на BRZ"], ["Кто-то другой (nobody_here)", "Ездит на Весте"]] as const) {
      await memoryRepository.create(fixture.auth, {
        attribute: "машина", confirmation: "model_high", content, kind: "profile",
        explicitSource: { conversationId: fixture.conversationId, subject: { kind: "label", label }, timelineEntryId: fixture.timelineEntryId },
        operationKey: `review-context-${label}`, provenance: { sessionId: "eve-session-ctx", turnId: "eve-turn-ctx" },
        scope: "family", sensitivity: "normal", source: "eve:eve-session-ctx:eve-turn-ctx",
      });
    }
    await memoryReviewRepository.initializeLane({
      conversationId: fixture.conversationId,
      messageThreadId: null,
      processedThroughSequence: "1",
    });
    await insertUserMessage({
      conversationId: fixture.conversationId, groupId: fixture.groupId,
      sentAt: "2026-09-03T09:00:00.000Z", sequence: 2,
    });

    const claims = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 10,
      now: new Date("2026-09-03T16:00:00.000Z"),
    });

    expect(claims).toHaveLength(1);
    expect(claims[0]!.prompt).toContain("<existing_memory>");
    expect(claims[0]!.prompt).toContain("Анна работает логистом");
    expect(claims[0]!.prompt).toContain("работа");
    // The subjects' slot names come first, so a new record reuses a slot instead of coining one;
    // a label subject «Имя (username)» is matched to the batch author by username, a label
    // that names no author is not shown.
    expect(claims[0]!.prompt).toMatch(/<existing_slots>[^]*: работа[^]*<\/existing_slots>[^]*<existing_memory>/u);
    const slotsBlock = claims[0]!.prompt.slice(0, claims[0]!.prompt.indexOf("</existing_slots>"));
    expect(slotsBlock).toContain("Анна (agent_memory_author): машина");
    expect(slotsBlock).not.toContain("Кто-то другой");
  });

  // Production, 3 October 2026: two external groups gave 97 % of all review batches, almost every
  // one of exactly ten sources; a chat with no family member in it does not need a call that often.
  it("lets an external group gather thirty fresh sources before its background batch", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const external = await externalGroup(fixture.familyId, true);
    for (let sequence = 1; sequence <= 10; sequence += 1) {
      await insertUserMessage({
        conversationId: external.conversationId, groupId: external.groupId,
        sentAt: "2026-09-03T10:09:30.000Z", sequence,
      });
    }
    const early = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000, limit: 10, now: new Date("2026-09-03T10:10:00.000Z"),
    });
    expect(early).toHaveLength(0);

    for (let sequence = 11; sequence <= 30; sequence += 1) {
      await insertUserMessage({
        conversationId: external.conversationId, groupId: external.groupId,
        sentAt: "2026-09-03T10:09:30.000Z", sequence,
      });
    }
    const full = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000, limit: 10, now: new Date("2026-09-03T10:10:00.000Z"),
    });
    expect(full).toHaveLength(1);
    expect(full[0]!.sourceCount).toBe(30);
  });

  it("flushes ten sources of an external group after thirty idle minutes, not ten", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const external = await externalGroup(fixture.familyId, true);
    for (let sequence = 1; sequence <= 10; sequence += 1) {
      await insertUserMessage({
        conversationId: external.conversationId, groupId: external.groupId,
        sentAt: "2026-09-03T10:00:00.000Z", sequence,
      });
    }
    const tenMinutes = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000, limit: 10, now: new Date("2026-09-03T10:11:00.000Z"),
    });
    expect(tenMinutes).toHaveLength(0);
    const thirtyMinutes = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000, limit: 10, now: new Date("2026-09-03T10:31:00.000Z"),
    });
    expect(thirtyMinutes).toHaveLength(1);
    expect(thirtyMinutes[0]!.sourceCount).toBe(10);
  });

  // 1000 groups: the review shares the Workflow workers with the turns, so the number of reviews
  // in flight is capped; a claim takes only what the cap leaves (scaling notes, 4 October 2026).
  it("claims no more background batches than the in-flight cap leaves", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const groups = await Promise.all([1, 2, 3].map((n) => externalGroup(fixture.familyId, true, `-100-cap-${n}`)));
    for (const group of groups) {
      for (let sequence = 1; sequence <= 30; sequence += 1) {
        await insertUserMessage({ conversationId: group.conversationId, groupId: group.groupId, sentAt: "2026-09-03T10:00:00.000Z", sequence });
      }
    }
    const first = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 600_000, limit: 10, maxInFlight: 2, now: new Date("2026-09-03T10:01:00.000Z"),
    });
    expect(first).toHaveLength(2);
    // Both dispatched and still running: the cap is full, the third lane waits.
    for (const [index, claimed] of first.entries()) {
      await database().query("UPDATE memory_review_batches SET status = 'running', eve_session_id = $2, eve_turn_id = 'turn_0' WHERE id = $1", [claimed.batchId, `wrun_cap_${index}`]);
    }
    const full = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 600_000, limit: 10, maxInFlight: 2, now: new Date("2026-09-03T10:02:00.000Z"),
    });
    expect(full).toHaveLength(0);
    // One review finished: one slot, one claim.
    await database().query("UPDATE memory_review_batches SET status = 'completed', completed_at = now() WHERE id = $1", [first[0]!.batchId]);
    const freed = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 600_000, limit: 10, maxInFlight: 2, now: new Date("2026-09-03T10:03:00.000Z"),
    });
    expect(freed).toHaveLength(1);
  });

  it("materializes at most the configured number of lanes per pass and the rest next time", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const groups = await Promise.all([1, 2, 3].map((n) => externalGroup(fixture.familyId, true, `-100-lanes-${n}`)));
    for (const group of groups) {
      for (let sequence = 1; sequence <= 30; sequence += 1) {
        await insertUserMessage({ conversationId: group.conversationId, groupId: group.groupId, sentAt: "2026-09-03T10:00:00.000Z", sequence });
      }
    }
    const first = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 600_000, limit: 10, materializeLaneLimit: 2, now: new Date("2026-09-03T10:01:00.000Z"),
    });
    expect(first).toHaveLength(2);
    const second = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 600_000, limit: 10, materializeLaneLimit: 2, now: new Date("2026-09-03T10:02:00.000Z"),
    });
    expect(second).toHaveLength(1);
  });

  it("never reviews a group whose owner switched silent review off", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const external = await externalGroup(fixture.familyId, false);
    const entries = [];
    for (let sequence = 1; sequence <= 50; sequence += 1) {
      entries.push(await insertUserMessage({
        conversationId: external.conversationId, groupId: external.groupId,
        sentAt: "2026-09-03T09:00:00.000Z", sequence,
      }));
    }
    // The inline fiftieth-message observer, the idle dispatcher and the long-idle flush all stay quiet.
    await expect(memoryReviewRepository.observePassiveMessage({
      groupId: external.groupId, timelineEntryId: entries[49]!.id,
    })).resolves.toBeNull();
    const claims = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000, limit: 10, now: new Date("2026-09-03T16:00:00.000Z"),
    });
    expect(claims).toHaveLength(0);
    await expect(memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: "00000000-0000-4000-8000-000000000001",
      groupId: external.groupId, timelineEntryId: entries[49]!.id,
    })).resolves.toBeNull();
  });
});

async function externalGroup(familyId: string, memoryReview: boolean, chatId = "-100-external-review") {
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode, memory_review_enabled)
     VALUES ($1, $3, 'Внешняя', 'external', 'all', $2) RETURNING id`,
    [familyId, memoryReview, chatId],
  );
  const conversation = await database().query<{ id: string }>(
    "SELECT id FROM application_conversations WHERE telegram_group_id = $1", [group.rows[0]!.id],
  );
  await memoryReviewRepository.initializeLane({
    conversationId: conversation.rows[0]!.id, messageThreadId: null, processedThroughSequence: "0",
  });
  return { conversationId: conversation.rows[0]!.id, groupId: group.rows[0]!.id };
}
