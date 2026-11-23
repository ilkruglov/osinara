/**
 * Who took a claim's evidence down.
 *
 * Constructs covered:
 * - A memory written in the person's own turn records `turn`; one written by the silent review of
 *   the chat records `review` (owner, 23 November 2026: a card ranks the first above the second).
 * - Someone's words saved in another person's turn were not told to Mia: `review`, like the
 *   review's (review of the fixes, 23 November 2026); the review is what `remember` writes with no
 *   actor (a background batch), the interactive tail is the chat's own turn.
 * - Migration 157 marks the evidence written before from the memory operation log and leaves the
 *   threads of its records alone.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// A thread's title is compared by meaning when it is created.
vi.mock("./memory-embedding-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./memory-embedding-client.js")>()),
  embedMemoryPassages: vi.fn(async () => [[1, ...Array.from({ length: 767 }, () => 0)]]),
}));

import { closeDatabase, database } from "./database.js";
import { createMainAgentMemoryFixture } from "./memory-agent-write.integration-fixtures.js";
import { memoryRepository } from "./memory-repository.js";
import { memoryTurnSourceRepository } from "./memory-turn-source-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;
if (enabled && (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

type MemoryFixture = Awaited<ReturnType<typeof createMainAgentMemoryFixture>>;

/** Saves a record about a message's author (Анна's current one by default) in Анна's turn. */
function remember(
  fixture: MemoryFixture,
  content: string,
  options: Partial<Parameters<typeof memoryRepository.create>[1]> & {
    timelineEntryId?: string;
  } = {},
) {
  const { timelineEntryId = fixture.timelineEntryId, ...input } = options;
  const provenance = input.provenance ?? { sessionId: "eve-anna", turnId: "turn-anna" };
  return memoryRepository.create(fixture.auth, {
    confirmation: "model_high",
    content,
    explicitSource: {
      conversationId: fixture.conversationId,
      subject: { kind: "current_author" },
      timelineEntryId,
    },
    kind: "preference",
    operationKey: `memory-${content}`,
    provenance,
    scope: "family",
    sensitivity: "normal",
    source: `eve:${provenance.sessionId}:${provenance.turnId}`,
    ...input,
  });
}

/** Each record of the family with who took its evidence down, by content. */
async function origins(familyId: string) {
  const result = await database().query<{ content: string; recorded_by: string | null }>(
    `SELECT item.content, evidence.recorded_by FROM memory_items_all AS item
     JOIN claim_evidence AS evidence ON evidence.claim_id = item.id
     WHERE item.family_id = $1 ORDER BY item.content`,
    [familyId],
  );
  return result.rows;
}

/** Анна's turn (`eve-anna`/`turn-anna`) sees Борис's earlier message and her own current one. */
async function annaTurnWithBoris(fixture: MemoryFixture): Promise<{ deltaId: string }> {
  const boris = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ('delta-author', 'Борис') RETURNING id",
  );
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'member')",
    [fixture.familyId, boris.rows[0]!.id],
  );
  const delta = await database().query<{ id: string }>(
    `INSERT INTO telegram_group_messages
         (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
          telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
       VALUES ($1, $2, 902, 2, 'user', 'telegram:delta-author', 'delta-author',
               'Борис', false, 'text', 'Я начинаю марафонские тренировки', now())
       RETURNING id`,
    [fixture.conversationId, fixture.groupId],
  );
  await database().query(
    `INSERT INTO conversation_participants
         (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
          linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
       VALUES ($1, $2, 'family', $2, 'delta-author', $3, 'Борис', now(), now())`,
    [fixture.conversationId, fixture.familyId, boris.rows[0]!.id],
  );
  const session = await database().query<{ id: string }>(
    `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, group_id, scope, kind, conversation_key,
          continuation_token, started_at, last_activity_at)
       VALUES (gen_random_uuid(), 0, $1, $2, 'family', 'canonical', 'origin-turn',
               'origin-turn:0', now(), now()) RETURNING id`,
    [fixture.familyId, fixture.groupId],
  );
  await memoryTurnSourceRepository.bind({
    applicationSessionId: session.rows[0]!.id,
    conversationId: fixture.conversationId,
    currentTimelineEntryId: fixture.timelineEntryId,
    eveSessionId: "eve-anna",
    eveTurnId: "turn-anna",
    invokingActorId: fixture.auth.telegramActorId!,
    invokingActorKind: "telegram_user",
    visibleTimelineEntryIds: [delta.rows[0]!.id, fixture.timelineEntryId],
  });
  return { deltaId: delta.rows[0]!.id };
}

/**
 * A batch turn of the chat (`sessionId`/`turnId`, the batch at `sequence` of the chat's lane) whose
 * sources include Анна's message: the silent review (background) or the interactive tail.
 */
async function batchTurn(
  fixture: MemoryFixture,
  kind: "background" | "interactive",
  sessionId: string,
  turnId: string,
  sequence: number,
): Promise<void> {
  const lane =
    (
      await database().query<{ id: string }>(
        "SELECT id FROM memory_review_lanes WHERE conversation_id = $1",
        [fixture.conversationId],
      )
    ).rows[0] ??
    (
      await database().query<{ id: string }>(
        `INSERT INTO memory_review_lanes (conversation_id, message_thread_id, processed_through_sequence)
         VALUES ($1, NULL, 0) RETURNING id`,
        [fixture.conversationId],
      )
    ).rows[0]!;
  // An interactive batch runs with its session (set below), as the turn of the chat starts it.
  const ended = kind === "interactive";
  const batch = await database().query<{ id: string }>(
    `INSERT INTO memory_review_batches
       (lane_id, conversation_id, batch_kind, status, predecessor_sequence, from_sequence,
        through_sequence, source_count, eve_session_id, started_at, completed_at)
     VALUES ($1, $2, $3, $4, $5::bigint, $5::bigint + 1, $5::bigint + 1, 1, $6, $7, $7)
     RETURNING id`,
    [
      lane.id,
      fixture.conversationId,
      kind,
      ended ? "completed" : "pending",
      sequence - 1,
      sessionId,
      ended ? new Date() : null,
    ],
  );
  const session = await database().query<{ id: string }>(
    `INSERT INTO conversation_sessions
       (thread_id, generation, family_id, group_id, scope, kind, conversation_key,
        continuation_token, started_at, last_activity_at, memory_review_batch_id, task_state)
     VALUES (gen_random_uuid(), 0, $1, $2, 'family', 'proactive', $3, $3, now(), now(), $4,
             'running') RETURNING id`,
    [fixture.auth.familyId, fixture.auth.groupId, `batch-${sessionId}`, batch.rows[0]!.id],
  );
  if (kind === "interactive") {
    await database().query(
      `UPDATE memory_review_batches
          SET status = 'running', application_session_id = $2, completed_at = NULL
        WHERE id = $1`,
      [batch.rows[0]!.id, session.rows[0]!.id],
    );
  }
  await database().query(
    `INSERT INTO memory_turn_source_sets
       (eve_session_id, eve_turn_id, application_session_id, conversation_id,
        current_timeline_entry_id, invoking_actor_id, invoking_actor_kind, binding_hash,
        memory_review_batch_id)
     VALUES ($1, $2, $3, $4, NULL, $5, 'telegram_user', repeat('b', 64), $6)`,
    [
      sessionId,
      turnId,
      session.rows[0]!.id,
      fixture.conversationId,
      fixture.auth.telegramActorId,
      batch.rows[0]!.id,
    ],
  );
  await database().query(
    `INSERT INTO memory_turn_sources
       (eve_session_id, eve_turn_id, conversation_id, timeline_entry_id, timeline_sequence,
        is_current)
     SELECT $1, $2, conversation_id, id, sequence_id, false
       FROM telegram_group_messages WHERE id = $3`,
    [sessionId, turnId, fixture.timelineEntryId],
  );
}

describeWithDatabase("claim evidence origin", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("records a turn's memory as told in the turn and a review's as taken down by it", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await remember(fixture, "Любит чай", {
      provenance: { sessionId: "eve-own", turnId: "turn-own" },
    });

    // A review turn of the chat: its source set is the batch's, the message among its sources.
    await batchTurn(fixture, "background", "eve-review", "turn-review", 1);
    // `remember` writes the silent review's records with no actor (`systemActor`).
    await remember(fixture, "Не любит кофе", {
      provenance: { sessionId: "eve-review", turnId: "turn-review" },
      systemActor: true,
    });
    // The interactive tail is a turn of the chat, not the silent review: her own words.
    await batchTurn(fixture, "interactive", "eve-tail", "turn-tail", 2);
    await remember(fixture, "Пьёт какао", {
      provenance: { sessionId: "eve-tail", turnId: "turn-tail" },
    });

    expect(await origins(fixture.auth.familyId)).toEqual([
      { content: "Любит чай", recorded_by: "turn" },
      { content: "Не любит кофе", recorded_by: "review" },
      { content: "Пьёт какао", recorded_by: "turn" },
    ]);
  });

  it("records someone's words saved in another person's turn as taken down from the chat", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const { deltaId } = await annaTurnWithBoris(fixture);
    await remember(fixture, "Борис тренируется к марафону", { timelineEntryId: deltaId });
    await remember(fixture, "Анна любит чай");

    expect(await origins(fixture.auth.familyId)).toEqual([
      { content: "Анна любит чай", recorded_by: "turn" },
      { content: "Борис тренируется к марафону", recorded_by: "review" },
    ]);
  });

  // Owner, 23 November 2026, after the review of the fixes: evidence written before the mark gets
  // it from the memory operation log (the review writes with no actor), and the threads its records
  // are in keep their briefs: the mark changes nothing they show.
  it("marks the evidence written before from the memory operation log", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const { deltaId } = await annaTurnWithBoris(fixture);
    await remember(fixture, "Анна начала готовиться к марафону", {
      kind: "episode",
      thread: {
        action: "create",
        identity: "subject",
        purpose: "Сохранять план подготовки",
        role: "goal",
        title: "Марафон",
      },
    });
    await remember(fixture, "Борис тренируется к марафону", { timelineEntryId: deltaId });
    // No actor and no review batch of the session: another bot's own turn writes so.
    await remember(fixture, "Борис бегает по утрам", {
      systemActor: true,
      timelineEntryId: deltaId,
    });
    // The silent review writes with no actor in its batch's session.
    await batchTurn(fixture, "background", "eve-review", "turn-review", 1);
    const reviewed = await remember(fixture, "Анна пьёт кофе", {
      provenance: { sessionId: "eve-review", turnId: "turn-review" },
      systemActor: true,
    });
    // A later write of the same record in another turn logs its own create: not the record's.
    await database().query(
      `INSERT INTO memory_mutation_operations
         (family_id, operation_key, mutation_kind, input_hash, memory_item_id, actor_user_id,
          actor_telegram_user_id, eve_session_id, eve_turn_id)
       VALUES ($1, 'backfill-later', 'create', repeat('c', 64), $2, $3, $4, 'eve-anna', 'turn-anna')`,
      [fixture.familyId, reviewed.id, fixture.userId, fixture.auth.telegramActorId],
    );
    // Only a later create of another key: not the record's own, so nothing to read.
    const later = await remember(fixture, "Анна любит сыр");
    await database().query("DELETE FROM memory_mutation_operations WHERE memory_item_id = $1", [
      later.id,
    ]);
    await database().query(
      `INSERT INTO memory_mutation_operations
         (family_id, operation_key, mutation_kind, input_hash, memory_item_id,
          eve_session_id, eve_turn_id)
       VALUES ($1, 'backfill-cheese-later', 'create', repeat('d', 64), $2, 'eve-review', 'turn-review')`,
      [fixture.familyId, later.id],
    );
    // No actor in the session of an interactive batch: the chat's turn, not the silent review.
    await batchTurn(fixture, "interactive", "eve-tail", "turn-tail", 2);
    await remember(fixture, "Анна ест пиццу", {
      provenance: { sessionId: "eve-tail", turnId: "turn-tail" },
      systemActor: true,
    });
    const lost = await remember(fixture, "Анна любит чай");
    await database().query("DELETE FROM memory_mutation_operations WHERE memory_item_id = $1", [
      lost.id,
    ]);
    await database().query("UPDATE claim_evidence SET recorded_by = NULL");
    const threads = async () =>
      (await database().query("SELECT id, generation FROM memory_threads ORDER BY id")).rows;
    const before = await threads();
    expect(before).toHaveLength(1);

    await database().query(
      await readFile(resolve("migrations/157_claim_evidence_recorded_by_backfill.sql"), "utf8"),
    );

    expect(await origins(fixture.auth.familyId)).toEqual([
      { content: "Анна ест пиццу", recorded_by: null },
      { content: "Анна любит сыр", recorded_by: null },
      { content: "Анна любит чай", recorded_by: null },
      { content: "Анна начала готовиться к марафону", recorded_by: "turn" },
      { content: "Анна пьёт кофе", recorded_by: "review" },
      { content: "Борис бегает по утрам", recorded_by: null },
      { content: "Борис тренируется к марафону", recorded_by: "review" },
    ]);
    expect(await threads()).toEqual(before);
    const trigger = await database().query<{ tgenabled: string }>(
      "SELECT tgenabled FROM pg_trigger WHERE tgname = 'claim_evidence_invalidate_thread_projections'",
    );
    expect(trigger.rows).toEqual([{ tgenabled: "O" }]);
  });
});
