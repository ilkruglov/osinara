/**
 * PostgreSQL long-term memory integration tests.
 *
 * Constructs covered:
 * - Scope filters prevent cross-user, cross-group, and cross-family disclosure.
 * - Family and group mutations enforce author-or-owner access against current database roles.
 * - Opaque refs resolve only inside the already-authorized family, personal, and group scope.
 * - Create/edit operations are replay-safe; edits preserve an explicit correction version chain.
 * - Physical deletion removes the searchable record.
 * - Pagination cursors contain stable opaque refs rather than database UUIDs.
 * - Scope quotas are enforced inside the write transaction.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { MemoryAuthorization } from "./memory-context.js";
import { closeDatabase, database } from "./database.js";
import { MEMORY_SCOPE_QUOTAS } from "./memory-config.js";
import { memoryRepository } from "./memory-repository.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDatabaseUrl = process.env.DATABASE_URL;

if (integrationTestsEnabled) {
  if (!integrationDatabaseUrl) {
    throw new Error(
      "AGENT_TEST_DATABASE_CONFIG_MISSING: Для integration-тестов не задан DATABASE_URL",
    );
  }
  if (!new URL(integrationDatabaseUrl).pathname.slice(1).endsWith("_test")) {
    throw new Error(
      "AGENT_TEST_DATABASE_UNSAFE: Integration-тесты разрешены только для БД с суффиксом _test",
    );
  }
}

const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;

interface FamilyFixture {
  familyId: string;
  member: MemoryAuthorization;
  owner: MemoryAuthorization;
}

const INVALID_SOURCE = {
  conversationId: "00000000-0000-4000-8000-000000000090",
  timelineEntryId: "00000000-0000-4000-8000-000000000091",
};

async function createFamily(suffix: string): Promise<FamilyFixture> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ($1) RETURNING id",
    [`Семья ${suffix}`],
  );
  const users = await database().query<{ id: string; telegram_user_id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ($1, $2), ($3, $4)
     RETURNING id, telegram_user_id`,
    [`owner-${suffix}`, `Владелец ${suffix}`, `member-${suffix}`, `Участник ${suffix}`],
  );
  const owner = users.rows.find((row) => row.telegram_user_id === `owner-${suffix}`)!;
  const member = users.rows.find((row) => row.telegram_user_id === `member-${suffix}`)!;
  await database().query(
    `INSERT INTO family_memberships (family_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
    [family.rows[0]!.id, owner.id, member.id],
  );
  await database().query(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, $2, $3, 'family_private', 'addressed_only')`,
    [family.rows[0]!.id, `family-${suffix}`, `Семейный чат ${suffix}`],
  );

  return {
    familyId: family.rows[0]!.id,
    member: {
      familyId: family.rows[0]!.id,
      groupId: null,
      role: "member",
      scopes: ["personal", "family"],
      telegramUserId: member.telegram_user_id,
      userId: member.id,
    },
    owner: {
      familyId: family.rows[0]!.id,
      groupId: null,
      role: "owner",
      scopes: ["personal", "family"],
      telegramUserId: owner.telegram_user_id,
      userId: owner.id,
    },
  };
}

async function correctionSource(
  auth: MemoryAuthorization,
  scope: "family" | "personal",
): Promise<{ conversationId: string; timelineEntryId: string }> {
  const conversation = await database().query<{
    id: string;
    sequence_id: string;
    telegram_group_id: string | null;
  }>(
    `UPDATE application_conversations
     SET next_timeline_sequence = next_timeline_sequence + 1
     WHERE family_id = $1 AND scope = $2
       AND ($2 = 'family' OR owner_user_id = $3)
     RETURNING id, telegram_group_id, next_timeline_sequence::text AS sequence_id`,
    [auth.familyId, scope, auth.userId],
  );
  const current = conversation.rows[0]!;
  const participant = await database().query<{ id: string }>(
    `INSERT INTO conversation_participants
       (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
        linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'Автор исправления', now(), now())
     ON CONFLICT (conversation_id, telegram_user_id) DO UPDATE SET last_observed_at = now()
     RETURNING id`,
    [current.id, auth.familyId, scope, scope === "family" ? auth.familyId : auth.userId,
      auth.telegramUserId, auth.userId],
  );
  expect(participant.rows[0]).toBeDefined();
  const entry = await database().query<{ id: string }>(
    `INSERT INTO telegram_group_messages
       (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
     VALUES ($1, $2, $3, $3, 'user', $4, $5, 'Автор исправления', false, 'text',
             'Исправь эту запись памяти', now()) RETURNING id`,
    [current.id, current.telegram_group_id, current.sequence_id,
      `telegram:${auth.telegramUserId}`, auth.telegramUserId],
  );
  return { conversationId: current.id, timelineEntryId: entry.rows[0]!.id };
}

function createInput(
  scope: "family" | "group" | "personal",
  operationKey: string,
  content = "Пользователь предпочитает короткие ответы",
) {
  return {
    confirmation: "user_confirmed" as const,
    content,
    kind: "preference" as const,
    operationKey,
    scope,
    sensitivity: "normal" as const,
    source: `eve:session:${operationKey}`,
  };
}

describeWithDatabase("memoryRepository", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE memory_embedding_jobs, behavior_preferences, memory_items, audit_events,
         telegram_groups, family_memberships, users, families CASCADE`,
    );
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("isolates personal records by user and every record by family", async () => {
    const first = await createFamily("first");
    const second = await createFamily("second");
    await memoryRepository.create(first.owner, createInput("personal", "first-owner"));
    await memoryRepository.create(first.member, createInput("personal", "first-member"));
    await memoryRepository.create(second.owner, createInput("personal", "second-owner"));

    const visible = await memoryRepository.list(first.owner, { limit: 20 });

    expect(visible.items).toHaveLength(1);
    expect(visible.items[0]?.author).toEqual({
      status: "current_member",
      telegramUserId: null,
      userId: first.owner.userId,
    });
  });

  it("allows only the family author or current owner to update and delete a shared record", async () => {
    const family = await createFamily("family-rights");
    const record = await memoryRepository.create(
      family.member,
      createInput("family", "family-create", "Отпуск запланирован на август"),
    );
    const source = await correctionSource(family.owner, "family");

    const corrected = await memoryRepository.updateByRef(family.owner, {
      content: "Отпуск запланирован на сентябрь",
      memoryRef: record.memoryRef,
      operationKey: "family-owner-update",
      source,
    });
    expect(corrected).toMatchObject({ content: "Отпуск запланирован на сентябрь" });
    expect(corrected.memoryRef).not.toBe(record.memoryRef);
    const versions = await database().query<{
      claim_status: string;
      content: string;
      memory_ref: string;
      relation_type: string | null;
    }>(
      `SELECT item.content, item.claim_status::text, ref.memory_ref,
              relation.relation_type::text
       FROM memory_items AS item
       JOIN memory_item_refs AS ref ON ref.memory_item_id = item.id
       LEFT JOIN claim_relations AS relation ON relation.source_claim_id = item.id
       WHERE item.id IN ($1, $2) ORDER BY item.created_at, item.id`,
      [record.id, corrected.id],
    );
    expect(versions.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        claim_status: "superseded",
        content: "Отпуск запланирован на август",
        memory_ref: record.memoryRef,
        relation_type: "correction",
      }),
      expect.objectContaining({
        claim_status: "active",
        content: "Отпуск запланирован на сентябрь",
        memory_ref: corrected.memoryRef,
      }),
    ]));
    await expect(memoryRepository.updateByRef(family.owner, {
      content: "Отпуск запланирован на сентябрь",
      memoryRef: record.memoryRef,
      operationKey: "family-owner-update",
      source,
    })).resolves.toEqual(corrected);

    const otherFamily = await createFamily("other-family");
    await expect(
      memoryRepository.updateByRef(otherFamily.owner, {
        content: "Чужое изменение",
        memoryRef: record.memoryRef,
        operationKey: "cross-family-update",
        source: INVALID_SOURCE,
      }),
    ).rejects.toThrowError(/AGENT_MEMORY_NOT_FOUND/);

    await database().query(
      "UPDATE family_memberships SET role = 'member' WHERE family_id = $1 AND user_id = $2",
      [family.familyId, family.owner.userId],
    );
    await expect(
      memoryRepository.deleteByRef(family.owner, record.memoryRef, "revoked-owner-delete"),
    ).rejects.toThrowError(/AGENT_MEMORY_MUTATION_DENIED/);
  });

  it("retains a family record without external identity after its author is deleted", async () => {
    const family = await createFamily("former-author");
    const record = await memoryRepository.create(
      family.member,
      createInput("family", "former-create", "Семейное правило остаётся общим"),
    );

    await database().query("DELETE FROM users WHERE id = $1", [family.member.userId]);
    const visible = await memoryRepository.list(family.owner, { limit: 20, scope: "family" });

    expect(visible.items).toHaveLength(1);
    expect(visible.items[0]).toMatchObject({
      id: record.id,
      author: {
        status: "former_member",
        telegramUserId: null,
        userId: null,
      },
    });
  });

  it("lets a Telegram group author manage their record and rejects another participant", async () => {
    const family = await createFamily("group-rights");
    const group = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, '-100101', 'Рабочая группа', 'external', 'addressed_only')
       RETURNING id`,
      [family.familyId],
    );
    const author: MemoryAuthorization = {
      familyId: family.familyId,
      groupId: group.rows[0]!.id,
      role: "external",
      scopes: ["group"],
      telegramUserId: "telegram-author",
      userId: null,
    };
    const stranger = { ...author, telegramUserId: "telegram-stranger" };
    const record = await memoryRepository.create(author, createInput("group", "group-create"));

    await expect(
      memoryRepository.updateByRef(stranger, {
        content: "Чужое изменение",
        memoryRef: record.memoryRef,
        operationKey: "group-stranger-update",
        source: INVALID_SOURCE,
      }),
    ).rejects.toThrowError(/AGENT_MEMORY_MUTATION_DENIED/);
    await expect(
      memoryRepository.deleteByRef(author, record.memoryRef, "group-author-delete"),
    ).resolves.toEqual({ deleted: true });
  });

  it("returns the original record for an identical Eve replay and rejects changed input", async () => {
    const family = await createFamily("replay");
    const input = createInput("personal", "same-call");
    const first = await memoryRepository.create(family.owner, input);

    await expect(memoryRepository.create(family.owner, input)).resolves.toEqual(first);
    await expect(
      memoryRepository.create(family.owner, { ...input, content: "Подменённое значение" }),
    ).rejects.toThrowError(/AGENT_MEMORY_REPLAY_MISMATCH/);
    expect(first.memoryRef).toMatch(/^mem_[0-9a-f]{32}$/u);
  });

  it("reinforces an exact explicit remember without creating a second claim", async () => {
    const family = await createFamily("explicit-exact");
    const first = await memoryRepository.create(
      family.owner,
      createInput("personal", "explicit-exact-first", "Анна любит улун"),
    );
    const second = await memoryRepository.create(
      family.owner,
      createInput("personal", "explicit-exact-second", "  анна   любит улун  "),
    );

    expect(second.id).toBe(first.id);
    const persisted = await database().query<{
      count: number;
      last_reinforced_at: Date | null;
      reinforcement_count: number;
    }>(
      `SELECT count(*) OVER ()::integer AS count, reinforcement_count, last_reinforced_at
       FROM memory_items WHERE family_id = $1 AND owner_user_id = $2`,
      [family.familyId, family.owner.userId],
    );
    expect(persisted.rows).toEqual([expect.objectContaining({
      count: 1,
      last_reinforced_at: expect.any(Date),
      reinforcement_count: 1,
    })]);
  });

  it("resolves opaque refs only inside the authorized scope", async () => {
    const family = await createFamily("ref-scope");
    const personal = await memoryRepository.create(
      family.owner,
      createInput("personal", "ref-personal"),
    );
    const shared = await memoryRepository.create(
      family.owner,
      createInput("family", "ref-family"),
    );
    const otherFamily = await createFamily("ref-other-family");

    await expect(memoryRepository.updateByRef(family.member, {
      content: "Чужая личная запись",
      memoryRef: personal.memoryRef,
      operationKey: "ref-cross-user",
      source: INVALID_SOURCE,
    })).rejects.toThrowError(/AGENT_MEMORY_NOT_FOUND/);

    const replayInput = {
      content: "Личная запись после исправления",
      memoryRef: personal.memoryRef,
      operationKey: "ref-owner-update",
      source: await correctionSource(family.owner, "personal"),
    };
    await expect(memoryRepository.updateByRef(family.owner, replayInput)).resolves.toMatchObject({
      content: replayInput.content,
    });
    await expect(
      memoryRepository.updateByRef(family.member, replayInput),
    ).rejects.toThrowError(/AGENT_MEMORY_NOT_FOUND/);
    await expect(memoryRepository.updateByRef(otherFamily.owner, {
      content: "Чужая семейная запись",
      memoryRef: shared.memoryRef,
      operationKey: "ref-cross-family",
      source: INVALID_SOURCE,
    })).rejects.toThrowError(/AGENT_MEMORY_NOT_FOUND/);

    const firstGroup = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, '-100201', 'Первая группа', 'external', 'addressed_only') RETURNING id`,
      [family.familyId],
    );
    const secondGroup = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, '-100202', 'Вторая группа', 'external', 'addressed_only') RETURNING id`,
      [family.familyId],
    );
    const groupAuthor: MemoryAuthorization = {
      familyId: family.familyId,
      groupId: firstGroup.rows[0]!.id,
      role: "external",
      scopes: ["group"],
      telegramUserId: "ref-group-author",
      userId: null,
    };
    const otherGroup = { ...groupAuthor, groupId: secondGroup.rows[0]!.id };
    const groupMemory = await memoryRepository.create(
      groupAuthor,
      createInput("group", "ref-group"),
    );

    await expect(
      memoryRepository.deleteByRef(otherGroup, groupMemory.memoryRef, "ref-cross-group"),
    ).rejects.toThrowError(/AGENT_MEMORY_NOT_FOUND/);
  });

  it("paginates with an opaque cursor that contains no database UUID", async () => {
    const family = await createFamily("cursor");
    const first = await memoryRepository.create(
      family.owner,
      createInput("personal", "cursor-first", "Альфа"),
    );
    await memoryRepository.create(
      family.owner,
      createInput("personal", "cursor-second", "Омега"),
    );

    const page = await memoryRepository.list(family.owner, { limit: 1 });

    expect(page.nextCursor).not.toBeNull();
    expect(page.nextCursor).not.toContain(first.id);
    expect(page.nextCursor).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-/iu);
    await expect(memoryRepository.list(family.owner, {
      cursor: page.nextCursor!,
      limit: 1,
    })).resolves.toMatchObject({ items: [{ memoryRef: expect.stringMatching(/^mem_/u) }] });
  });

  it("enforces the configured personal quota before inserting another record", async () => {
    const family = await createFamily("quota");
    await database().query(
      `INSERT INTO memory_items
         (family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind,
          content, source, confirmation, sensitivity, operation_key)
       SELECT $1, $2, $2, $3, 'personal', 'fact', 'Факт ' || value::text,
              'test:quota', 'user_confirmed', 'normal', 'quota-' || value::text
       FROM generate_series(1, $4) AS value`,
      [family.familyId, family.owner.userId, family.owner.telegramUserId, MEMORY_SCOPE_QUOTAS.personal],
    );

    await expect(
      memoryRepository.create(family.owner, createInput("personal", "over-quota")),
    ).rejects.toThrowError(/AGENT_MEMORY_QUOTA_EXCEEDED/);
  });

  it("physically removes the memory, embedding job, and searchable content while retaining safe audit metadata", async () => {
    const family = await createFamily("delete");
    const record = await memoryRepository.create(
      family.owner,
      createInput("personal", "delete-create", "Секретное описание без учётных данных"),
    );

    await expect(
      memoryRepository.deleteByRef(family.owner, record.memoryRef, "delete-call"),
    ).resolves.toEqual({ deleted: true });
    const persisted = await database().query(
      "SELECT 1 FROM memory_items WHERE id = $1",
      [record.id],
    );
    const jobs = await database().query(
      "SELECT 1 FROM memory_embedding_jobs WHERE memory_item_id = $1",
      [record.id],
    );
    const audit = await database().query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE subject_id = $1 AND event_type = 'memory.deleted'",
      [record.id],
    );

    expect(persisted.rowCount).toBe(0);
    expect(jobs.rowCount).toBe(0);
    expect(audit.rows[0]?.metadata).not.toHaveProperty("content");
  });
});
