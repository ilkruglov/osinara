/**
 * Main-agent durable memory write integration tests.
 *
 * Constructs covered:
 * - One verified Telegram source creates a claim, provenance operation, and optional thread entry.
 * - Thread identity is derived from the current author rather than model-supplied database IDs.
 * - Strong semantic-title or lexical-purpose matches block accidental duplicate threads atomically.
 * - An invalid thread target rolls back the entire claim operation.
 * - Main-agent writes enqueue only local claim embeddings, never extraction/classifier/brief jobs.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./memory-embedding-client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./memory-embedding-client.js")>(),
  embedMemoryPassages: vi.fn(async () => [
    [1, ...Array.from({ length: 383 }, () => 0)],
  ]),
}));

import { closeDatabase, database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { embedMemoryPassages } from "./memory-embedding-client.js";
import { memoryRepository } from "./memory-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;
const POSITIVE_VECTOR = [1, ...Array.from({ length: 383 }, () => 0)];
const NEGATIVE_VECTOR = [-1, ...Array.from({ length: 383 }, () => 0)];
const SEMANTIC_DUPLICATE_VECTOR = [
  0.925,
  Math.sqrt(1 - 0.925 ** 2),
  ...Array.from({ length: 382 }, () => 0),
];
const DISTINCT_TOPIC_VECTOR = [
  0.9,
  Math.sqrt(1 - 0.9 ** 2),
  ...Array.from({ length: 382 }, () => 0),
];

async function createFixture() {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Main agent memory') RETURNING id",
  );
  const user = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ('agent-memory-author', 'Анна') RETURNING id",
  );
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [family.rows[0]!.id, user.rows[0]!.id],
  );
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, '-100-agent-memory', 'Семья', 'family_private', 'addressed_only') RETURNING id`,
    [family.rows[0]!.id],
  );
  const conversation = await database().query<{ id: string }>(
    "SELECT id FROM application_conversations WHERE telegram_group_id = $1",
    [group.rows[0]!.id],
  );
  await database().query(
    `INSERT INTO conversation_participants
       (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
        linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
     VALUES ($1, $2, 'family', $2, 'agent-memory-author', $3, 'Анна', now(), now())`,
    [conversation.rows[0]!.id, family.rows[0]!.id, user.rows[0]!.id],
  );
  const message = await database().query<{ id: string }>(
    `INSERT INTO telegram_group_messages
       (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
     VALUES ($1, $2, 901, 1, 'user', 'telegram:agent-memory-author', 'agent-memory-author',
             'Анна', false, 'text', 'Я начинаю готовиться к марафону', now()) RETURNING id`,
    [conversation.rows[0]!.id, group.rows[0]!.id],
  );
  const auth: MemoryAuthorization = {
    familyId: family.rows[0]!.id,
    groupId: group.rows[0]!.id,
    role: "owner",
    scopes: ["family"],
    telegramUserId: "agent-memory-author",
    userId: user.rows[0]!.id,
  };
  return {
    auth,
    conversationId: conversation.rows[0]!.id,
    timelineEntryId: message.rows[0]!.id,
    userId: user.rows[0]!.id,
  };
}

describeWithDatabase("main-agent memory write", () => {
  beforeEach(async () => {
    vi.mocked(embedMemoryPassages).mockReset().mockResolvedValue([
      POSITIVE_VECTOR,
    ]);
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("atomically creates an author-bound claim and thread without specialized model jobs", async () => {
    const fixture = await createFixture();
    const memory = await memoryRepository.create(fixture.auth, {
      confirmation: "model_high",
      content: "Анна начала готовиться к марафону",
      explicitSource: {
        conversationId: fixture.conversationId,
        timelineEntryId: fixture.timelineEntryId,
      },
      kind: "episode",
      operationKey: "agent-memory-create-thread",
      provenance: { sessionId: "eve-session-main", turnId: "eve-turn-main" },
      scope: "family",
      sensitivity: "normal",
      source: "eve:eve-session-main:eve-turn-main",
      thread: {
        action: "create",
        identity: "subject",
        purpose: "Сохранять план, ограничения и результаты подготовки",
        role: "goal",
        title: "Марафон",
      },
    });

    expect(memory.thread).toEqual({
      action: "created",
      threadRef: expect.stringMatching(/^thread_[0-9a-f]{32}$/u),
    });
    await expect(database().query(
      `SELECT item.subject_user_id, operation.actor_user_id, operation.actor_telegram_user_id,
              operation.eve_session_id, operation.eve_turn_id, entry.role::text,
              thread.subject_user_id AS thread_subject_user_id
       FROM memory_items AS item
       JOIN memory_mutation_operations AS operation ON operation.memory_item_id = item.id
       JOIN memory_thread_entries AS entry ON entry.source_claim_id = item.id
       JOIN memory_threads AS thread ON thread.id = entry.thread_id
       WHERE item.id = $1`,
      [memory.id],
    )).resolves.toMatchObject({ rows: [{
      actor_telegram_user_id: "agent-memory-author",
      actor_user_id: fixture.userId,
      eve_session_id: "eve-session-main",
      eve_turn_id: "eve-turn-main",
      role: "goal",
      subject_user_id: fixture.userId,
      thread_subject_user_id: fixture.userId,
    }] });
    await expect(database().query(
      `SELECT
         (SELECT count(*)::integer FROM memory_extraction_jobs) AS extraction_jobs,
         (SELECT count(*)::integer FROM memory_consolidation_jobs) AS consolidation_jobs,
         (SELECT count(*)::integer FROM memory_thread_discovery_jobs) AS discovery_jobs,
         (SELECT count(*)::integer FROM memory_thread_brief_jobs) AS brief_jobs,
         (SELECT count(*)::integer FROM memory_thread_creation_notices
           WHERE status = 'pending') AS pending_notices`,
    )).resolves.toMatchObject({ rows: [{
      brief_jobs: 0,
      consolidation_jobs: 0,
      discovery_jobs: 0,
      extraction_jobs: 0,
      pending_notices: 1,
    }] });
  });

  it("keeps exact reinforcement isolated between semantically distinct project identities", async () => {
    const fixture = await createFixture();
    vi.mocked(embedMemoryPassages)
      .mockResolvedValueOnce([POSITIVE_VECTOR])
      .mockResolvedValueOnce([NEGATIVE_VECTOR]);
    const input = (title: string, operationKey: string) => ({
      confirmation: "model_high" as const,
      content: "Подготовка продолжается по плану",
      explicitSource: {
        conversationId: fixture.conversationId,
        timelineEntryId: fixture.timelineEntryId,
      },
      kind: "fact" as const,
      operationKey,
      scope: "family" as const,
      sensitivity: "normal" as const,
      source: `eve:${operationKey}`,
      thread: {
        action: "create" as const,
        identity: "project" as const,
        purpose: title,
        role: "goal" as const,
        title,
      },
    });

    const first = await memoryRepository.create(fixture.auth, input("Марафон", "project-a"));
    const second = await memoryRepository.create(fixture.auth, input("Ремонт кухни", "project-b"));

    expect(second.id).not.toBe(first.id);
    await expect(database().query(
      `SELECT count(DISTINCT item.id)::integer AS claims,
              count(DISTINCT item.memory_project_id)::integer AS projects
       FROM memory_items AS item WHERE item.operation_key IN ('project-a', 'project-b')`,
    )).resolves.toMatchObject({ rows: [{ claims: 2, projects: 2 }] });
  });

  it("rejects a semantically similar thread title and rolls back the new claim", async () => {
    const fixture = await createFixture();
    vi.mocked(embedMemoryPassages)
      .mockResolvedValueOnce([POSITIVE_VECTOR])
      .mockResolvedValueOnce([SEMANTIC_DUPLICATE_VECTOR]);
    const first = await memoryRepository.create(fixture.auth, {
      confirmation: "model_high",
      content: "Начинаю готовиться к первому марафону",
      explicitSource: {
        conversationId: fixture.conversationId,
        timelineEntryId: fixture.timelineEntryId,
      },
      kind: "episode",
      operationKey: "thread-candidate-semantic-first",
      scope: "family",
      sensitivity: "normal",
      source: "eve:thread-candidate-semantic-first",
      thread: {
        action: "create",
        purpose: "Сохранять план подготовки и результаты забегов",
        role: "goal",
        title: "Марафон 2027",
      },
    });

    await expect(memoryRepository.create(fixture.auth, {
      confirmation: "model_high",
      content: "Определён новый этап тренировочного плана",
      explicitSource: {
        conversationId: fixture.conversationId,
        timelineEntryId: fixture.timelineEntryId,
      },
      kind: "fact",
      operationKey: "thread-candidate-semantic-second",
      scope: "family",
      sensitivity: "normal",
      source: "eve:thread-candidate-semantic-second",
      thread: {
        action: "create",
        purpose: "Контролировать тренировочную нагрузку",
        role: "method",
        title: "План марафона",
      },
    })).rejects.toThrowError(
      new RegExp(
        `AGENT_MEMORY_THREAD_CANDIDATE_EXISTS.*${first.thread!.threadRef}.*не более одной попытки`,
        "u",
      ),
    );
    await expect(database().query(
      `SELECT
         (SELECT count(*)::integer FROM memory_threads) AS threads,
         (SELECT count(*)::integer FROM memory_items
          WHERE operation_key = 'thread-candidate-semantic-second') AS rejected_claims`,
    )).resolves.toMatchObject({ rows: [{ rejected_claims: 0, threads: 1 }] });
  });

  it("allows a distinct topic above the broader retrieval similarity gate", async () => {
    const fixture = await createFixture();
    vi.mocked(embedMemoryPassages)
      .mockResolvedValueOnce([POSITIVE_VECTOR])
      .mockResolvedValueOnce([DISTINCT_TOPIC_VECTOR]);
    const input = (title: string, purpose: string, operationKey: string) => ({
      confirmation: "model_high" as const,
      content: `Начата отдельная тема: ${title}`,
      explicitSource: {
        conversationId: fixture.conversationId,
        timelineEntryId: fixture.timelineEntryId,
      },
      kind: "fact" as const,
      operationKey,
      scope: "family" as const,
      sensitivity: "normal" as const,
      source: `eve:${operationKey}`,
      thread: {
        action: "create" as const,
        purpose,
        role: "goal" as const,
        title,
      },
    });

    const first = await memoryRepository.create(fixture.auth, input(
      "Инвестиции",
      "Планировать инвестиционные взносы и финансовые цели",
      "distinct-topic-first",
    ));
    const second = await memoryRepository.create(fixture.auth, input(
      "Физическая форма",
      "Следить за массой тела, сном и режимом дня",
      "distinct-topic-second",
    ));

    expect(first.thread).toMatchObject({ action: "created" });
    expect(second.thread).toMatchObject({ action: "created" });
    expect(second.thread!.threadRef).not.toBe(first.thread!.threadRef);
    await expect(database().query(
      "SELECT count(*)::integer AS threads FROM memory_threads",
    )).resolves.toMatchObject({ rows: [{ threads: 2 }] });
  });

  it("rejects a thread with a strongly matching purpose despite a dissimilar title vector", async () => {
    const fixture = await createFixture();
    vi.mocked(embedMemoryPassages)
      .mockResolvedValueOnce([POSITIVE_VECTOR])
      .mockResolvedValueOnce([NEGATIVE_VECTOR]);
    const first = await memoryRepository.create(fixture.auth, {
      confirmation: "model_high",
      content: "Начинаем ремонт кухни",
      explicitSource: {
        conversationId: fixture.conversationId,
        timelineEntryId: fixture.timelineEntryId,
      },
      kind: "episode",
      operationKey: "thread-candidate-purpose-first",
      scope: "family",
      sensitivity: "normal",
      source: "eve:thread-candidate-purpose-first",
      thread: {
        action: "create",
        identity: "project",
        purpose: "Сохранять решения и результаты ремонта кухни",
        role: "goal",
        title: "Кухня",
      },
    });

    await expect(memoryRepository.create(fixture.auth, {
      confirmation: "model_high",
      content: "Выбираем материалы для кухонного ремонта",
      explicitSource: {
        conversationId: fixture.conversationId,
        timelineEntryId: fixture.timelineEntryId,
      },
      kind: "fact",
      operationKey: "thread-candidate-purpose-second",
      scope: "family",
      sensitivity: "normal",
      source: "eve:thread-candidate-purpose-second",
      thread: {
        action: "create",
        identity: "project",
        purpose: "Сохранять решения и результаты ремонта кухни",
        role: "decision",
        title: "Материалы",
      },
    })).rejects.toThrowError(
      new RegExp(`AGENT_MEMORY_THREAD_CANDIDATE_EXISTS.*${first.thread!.threadRef}`, "u"),
    );
    await expect(database().query(
      `SELECT
         (SELECT count(*)::integer FROM memory_projects) AS projects,
         (SELECT count(*)::integer FROM memory_items
          WHERE operation_key = 'thread-candidate-purpose-second') AS rejected_claims`,
    )).resolves.toMatchObject({ rows: [{ projects: 1, rejected_claims: 0 }] });
  });

  it("attaches to an exact active title instead of treating it as an ambiguous candidate", async () => {
    const fixture = await createFixture();
    const create = (content: string, operationKey: string) => memoryRepository.create(fixture.auth, {
      confirmation: "model_high" as const,
      content,
      explicitSource: {
        conversationId: fixture.conversationId,
        timelineEntryId: fixture.timelineEntryId,
      },
      kind: "fact" as const,
      operationKey,
      scope: "family" as const,
      sensitivity: "normal" as const,
      source: `eve:${operationKey}`,
      thread: {
        action: "create" as const,
        purpose: "Сохранять подготовку и результаты",
        role: "goal" as const,
        title: "Марафон",
      },
    });

    const first = await create("Подготовка началась", "exact-title-first");
    const second = await create("Добавлен новый этап подготовки", "exact-title-second");

    expect(first.thread).toMatchObject({ action: "created" });
    expect(second.thread).toEqual({ action: "attached", threadRef: first.thread!.threadRef });
    await expect(database().query(
      "SELECT count(*)::integer AS count FROM memory_threads",
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("replays a created thread without requiring another embedding call", async () => {
    const fixture = await createFixture();
    const input = {
      confirmation: "model_high" as const,
      content: "Анна начала готовиться к марафону",
      explicitSource: {
        conversationId: fixture.conversationId,
        timelineEntryId: fixture.timelineEntryId,
      },
      kind: "episode" as const,
      operationKey: "agent-memory-replay-thread",
      scope: "family" as const,
      sensitivity: "normal" as const,
      source: "eve:replay",
      thread: {
        action: "create" as const,
        purpose: "Сохранять подготовку",
        role: "goal" as const,
        title: "Марафон",
      },
    };
    const first = await memoryRepository.create(fixture.auth, input);
    vi.mocked(embedMemoryPassages).mockRejectedValueOnce(new Error("embedding unavailable"));

    await expect(memoryRepository.create(fixture.auth, input)).resolves.toEqual(first);
    expect(embedMemoryPassages).toHaveBeenCalledTimes(1);
  });

  it("denies a replay after live family membership revocation", async () => {
    const fixture = await createFixture();
    const input = {
      confirmation: "model_high" as const,
      content: "Анна начала готовиться к марафону",
      explicitSource: {
        conversationId: fixture.conversationId,
        timelineEntryId: fixture.timelineEntryId,
      },
      kind: "episode" as const,
      operationKey: "agent-memory-revoked-replay",
      scope: "family" as const,
      sensitivity: "normal" as const,
      source: "eve:revoked-replay",
    };
    await memoryRepository.create(fixture.auth, input);
    await database().query(
      "DELETE FROM family_memberships WHERE family_id = $1 AND user_id = $2",
      [fixture.auth.familyId, fixture.auth.userId],
    );

    await expect(memoryRepository.create(fixture.auth, input))
      .rejects.toThrowError(/AGENT_ACCESS_DENIED/u);
  });

  it("rolls back the claim when an attached opaque thread ref is unavailable", async () => {
    const fixture = await createFixture();

    await expect(memoryRepository.create(fixture.auth, {
      confirmation: "model_high",
      content: "Эта запись не должна сохраниться",
      explicitSource: {
        conversationId: fixture.conversationId,
        timelineEntryId: fixture.timelineEntryId,
      },
      kind: "fact",
      operationKey: "agent-memory-invalid-thread",
      provenance: { sessionId: "eve-session-main", turnId: "eve-turn-invalid" },
      scope: "family",
      sensitivity: "normal",
      source: "eve:eve-session-main:eve-turn-invalid",
      thread: {
        action: "attach",
        role: "constraint",
        threadRef: "thread_11111111111111111111111111111111",
      },
    })).rejects.toThrowError(/AGENT_MEMORY_THREAD_NOT_FOUND/u);

    await expect(database().query(
      "SELECT count(*)::integer AS count FROM memory_items WHERE operation_key = $1",
      ["agent-memory-invalid-thread"],
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });
});
