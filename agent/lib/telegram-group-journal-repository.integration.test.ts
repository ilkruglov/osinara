/**
 * PostgreSQL Telegram group journal integration tests.
 *
 * Constructs covered:
 * - `telegramGroupJournalRepository`: normalized insertion, deduplication, topic isolation, ordering, and retention.
 * - `telegramGroupAdministrationRepository`: explicit mode persistence and family-scoped cascading removal.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES } from "../config.js";
import { closeDatabase, database } from "./database.js";
import { telegramGroupAttachmentRepository } from "./attachments/telegram-group-attachment-repository.js";
import { telegramGroupAdministrationRepository } from "./telegram-group-administration-repository.js";
import { telegramGroupJournalRepository } from "./telegram-group-journal-repository.js";
import { telegramRepository } from "./telegram-repository.js";

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

async function createOwnedFamily(suffix: string): Promise<{ familyId: string; ownerId: string }> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ($1) RETURNING id",
    [`Семья ${suffix}`],
  );
  const user = await database().query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ($1, $2) RETURNING id`,
    [`owner-${suffix}`, `Владелец ${suffix}`],
  );
  const familyId = family.rows[0]!.id;
  const ownerId = user.rows[0]!.id;
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [familyId, ownerId],
  );
  return { familyId, ownerId };
}

function message(input: {
  id: string;
  isTopicMessage?: boolean;
  text?: string;
  threadId?: number;
  withPhoto?: boolean;
}): TelegramMessage {
  return {
    attachments: input.withPhoto ? [{ fileId: "photo-file", kind: "photo" }] : [],
    caption: "",
    chat: { id: "-1001", title: "Группа", type: "supergroup" },
    from: { firstName: "Анна", id: "101", isBot: false, username: "anna" },
    messageId: input.id,
    ...(input.threadId === undefined ? {} : { messageThreadId: input.threadId }),
    raw: {
      date: 1_700_000_000 + Number(input.id),
      ...(input.isTopicMessage === undefined
        ? {}
        : { is_topic_message: input.isTopicMessage }),
      ...(input.withPhoto ? { photo: [{ file_id: "photo-file" }] } : {}),
    },
    text: input.text ?? "",
  };
}

describeWithDatabase("Telegram group journal repositories", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE invitations, memory_items,
         telegram_group_messages, telegram_groups, family_memberships, users, families CASCADE`,
    );
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("persists an explicit group mode and returns it from Telegram lookup", async () => {
    const { familyId, ownerId } = await createOwnedFamily("mode");

    await telegramGroupAdministrationRepository.registerGroup({
      familyId,
      messageMode: "all",
      requestedBy: ownerId,
      telegramChatId: "-1001",
      title: "Группа",
      toolAllowlist: ["remember"],
      type: "external",
    });

    await expect(telegramRepository.findGroup("-1001")).resolves.toMatchObject({
      familyId,
      messageMode: "all",
      telegramChatId: "-1001",
      toolAllowlist: ["remember"],
    });
  });

  it("preserves the unified timeline when the legacy invocation mode changes", async () => {
    const { familyId, ownerId } = await createOwnedFamily("mode-downgrade");
    const registration = {
      familyId,
      messageMode: "all" as const,
      requestedBy: ownerId,
      telegramChatId: "-1001",
      title: "Группа",
      toolAllowlist: [],
      type: "external" as const,
    };
    const group = await telegramGroupAdministrationRepository.registerGroup(registration);
    await telegramGroupJournalRepository.record(group.groupId, message({ id: "1", text: "данные" }));

    await telegramGroupAdministrationRepository.registerGroup({
      ...registration,
      messageMode: "addressed_only",
    });

    const retained = await database().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM telegram_group_messages WHERE group_id = $1",
      [group.groupId],
    );
    expect(retained.rows[0]?.count).toBe("1");
  });

  it("replaces the group and purges journal data when its trust-zone type changes", async () => {
    const { familyId, ownerId } = await createOwnedFamily("type-change");
    const initial = await telegramGroupAdministrationRepository.registerGroup({
      familyId,
      messageMode: "all",
      requestedBy: ownerId,
      telegramChatId: "-1001",
      title: "Семейная группа",
      toolAllowlist: [],
      type: "family_private",
    });
    await telegramGroupJournalRepository.record(initial.groupId, message({ id: "1", text: "семейные данные" }));

    const replacement = await telegramGroupAdministrationRepository.registerGroup({
      familyId,
      messageMode: "all",
      requestedBy: ownerId,
      telegramChatId: "-1001",
      title: "Внешняя группа",
      toolAllowlist: ["remember"],
      type: "external",
    });

    expect(replacement.groupId).not.toBe(initial.groupId);
    const retained = await database().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM telegram_group_messages",
    );
    expect(retained.rows[0]?.count).toBe("0");
  });

  it("also replaces an external trust zone when it becomes a family group", async () => {
    const { familyId, ownerId } = await createOwnedFamily("reverse-type-change");
    const initial = await telegramGroupAdministrationRepository.registerGroup({
      familyId,
      messageMode: "all",
      requestedBy: ownerId,
      telegramChatId: "-1001",
      title: "Внешняя группа",
      toolAllowlist: ["remember"],
      type: "external",
    });
    await telegramGroupJournalRepository.record(initial.groupId, message({ id: "1", text: "внешние данные" }));

    const replacement = await telegramGroupAdministrationRepository.registerGroup({
      familyId,
      messageMode: "addressed_only",
      requestedBy: ownerId,
      telegramChatId: "-1001",
      title: "Семейная группа",
      toolAllowlist: [],
      type: "family_private",
    });

    expect(replacement.groupId).not.toBe(initial.groupId);
    await expect(database().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM telegram_group_messages",
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("deduplicates messages and reads numeric order only from the same forum topic", async () => {
    const { familyId, ownerId } = await createOwnedFamily("journal");
    const group = await telegramGroupAdministrationRepository.registerGroup({
      familyId,
      messageMode: "all",
      requestedBy: ownerId,
      telegramChatId: "-1001",
      title: "Группа",
      toolAllowlist: [],
      type: "external",
    });

    await expect(
      telegramGroupJournalRepository.record(
        group.groupId,
        message({ id: "9", isTopicMessage: true, text: "девять", threadId: 7 }),
      ),
    ).resolves.toMatchObject({ status: "inserted" });
    await telegramGroupJournalRepository.record(
      group.groupId,
      message({ id: "10", isTopicMessage: true, text: "десять", threadId: 7 }),
    );
    await telegramGroupJournalRepository.record(
      group.groupId,
      message({ id: "11", isTopicMessage: true, text: "другая тема", threadId: 8 }),
    );
    await expect(
      telegramGroupJournalRepository.record(
        group.groupId,
        message({ id: "10", isTopicMessage: true, text: "повтор", threadId: 7 }),
      ),
    ).resolves.toMatchObject({ status: "duplicate" });

    const entries = await telegramGroupJournalRepository.listRecent({
      anchorEntryId: null,
      beforeSequence: null,
      groupId: group.groupId,
      limit: 50,
      messageThreadId: "7",
    });
    expect(entries.map((entry) => [entry.telegramMessageId, entry.contentText])).toEqual([
      ["9", "девять"],
      ["10", "десять"],
    ]);
  });

  it("stores an ordinary supergroup reply thread in the shared main journal", async () => {
    const { familyId, ownerId } = await createOwnedFamily("reply-thread");
    const group = await telegramGroupAdministrationRepository.registerGroup({
      familyId,
      messageMode: "all",
      requestedBy: ownerId,
      telegramChatId: "-1001",
      title: "Группа",
      toolAllowlist: [],
      type: "family_private",
    });

    await telegramGroupJournalRepository.record(
      group.groupId,
      message({ id: "20", text: "ответ без форумной темы", threadId: 310 }),
    );

    await expect(telegramGroupJournalRepository.listRecent({
      anchorEntryId: null,
      beforeSequence: null,
      groupId: group.groupId,
      limit: 50,
      messageThreadId: null,
    })).resolves.toMatchObject([{
      contentText: "ответ без форумной темы",
      messageThreadId: null,
      telegramMessageId: "20",
    }]);
    await expect(telegramGroupJournalRepository.listRecent({
      anchorEntryId: null,
      beforeSequence: null,
      groupId: group.groupId,
      limit: 50,
      messageThreadId: "310",
    })).resolves.toEqual([]);
  });

  it("stores media metadata without downloading or persisting Telegram raw payloads", async () => {
    const { familyId, ownerId } = await createOwnedFamily("media");
    const group = await telegramGroupAdministrationRepository.registerGroup({
      familyId,
      messageMode: "all",
      requestedBy: ownerId,
      telegramChatId: "-1001",
      title: "Группа",
      toolAllowlist: [],
      type: "external",
    });

    await telegramGroupJournalRepository.record(
      group.groupId,
      message({ id: "1", withPhoto: true }),
    );
    const entries = await telegramGroupJournalRepository.listRecent({
      anchorEntryId: null,
      beforeSequence: null,
      groupId: group.groupId,
      limit: 50,
      messageThreadId: null,
    });

    expect(entries[0]).toMatchObject({ contentText: null, messageKind: "photo" });
    const columns = await database().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'telegram_group_messages'`,
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain("raw");
  });

  it("retains and authorizes a lazy family attachment in addressed-only mode", async () => {
    const { familyId, ownerId } = await createOwnedFamily("lazy-family-media");
    const group = await telegramGroupAdministrationRepository.registerGroup({
      familyId,
      messageMode: "addressed_only",
      requestedBy: ownerId,
      telegramChatId: "-1001",
      title: "Семейная группа",
      toolAllowlist: [],
      type: "family_private",
    });
    const familyMessage: TelegramMessage = {
      ...message({ id: "42", text: "договор" }),
      attachments: [{
        fileId: "telegram-file-secret",
        fileName: "договор.pdf",
        fileUniqueId: "stable-file-id",
        kind: "document",
        mediaType: "application/pdf",
        size: 1_024,
      }],
      raw: { date: 1_700_000_042, document: { file_id: "telegram-file-secret" } },
    };

    await telegramGroupJournalRepository.record(group.groupId, familyMessage);
    const reference = await telegramGroupAttachmentRepository.record(
      group.groupId,
      familyMessage,
    );
    const auth = {
      familyId,
      groupId: group.groupId,
      groupType: "family_private" as const,
      role: "owner" as const,
      telegramChatType: "supergroup" as const,
      userId: ownerId,
    };

    await expect(
      telegramGroupAttachmentRepository.find(auth, reference.attachmentId),
    ).resolves.toEqual({
      attachment: familyMessage.attachments[0],
      chatId: "-1001",
      messageId: "42",
    });
    const entries = await telegramGroupJournalRepository.listRecent({
      anchorEntryId: null,
      beforeSequence: null,
      groupId: group.groupId,
      limit: 50,
      messageThreadId: null,
    });
    expect(entries[0]?.attachment).toEqual({
      attachmentId: reference.attachmentId,
      fileName: "договор.pdf",
      kind: "document",
      mediaType: "application/pdf",
      size: 1_024,
    });
    await expect(
      telegramGroupAttachmentRepository.list(auth, null),
    ).resolves.toMatchObject([{
      attachmentId: reference.attachmentId,
      contentText: "договор",
      fileName: "договор.pdf",
      telegramMessageId: "42",
    }]);
  });

  it("physically prunes messages beyond the configured per-group retention cap", async () => {
    const { familyId, ownerId } = await createOwnedFamily("retention");
    const group = await telegramGroupAdministrationRepository.registerGroup({
      familyId,
      messageMode: "all",
      requestedBy: ownerId,
      telegramChatId: "-1001",
      title: "Группа",
      toolAllowlist: [],
      type: "external",
    });
    await database().query(
      `INSERT INTO telegram_group_messages
         (group_id, sequence_id, actor_kind, actor_id, telegram_message_id,
          telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
       SELECT $1, value, 'user', 'telegram:101', value, '101', 'Анна', false, 'text', 'seed', now()
       FROM generate_series(1, $2) AS value`,
      [group.groupId, TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES],
    );
    await telegramGroupJournalRepository.record(
      group.groupId,
      message({ id: String(TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES + 1), text: "новая" }),
    );

    const retained = await database().query<{ count: string; minimum: string }>(
      `SELECT count(*)::text AS count, min(telegram_message_id)::text AS minimum
       FROM telegram_group_messages WHERE group_id = $1`,
      [group.groupId],
    );
    expect(retained.rows[0]).toEqual({
      count: String(TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES),
      minimum: "2",
    });
    const newest = await database().query<{ maximum: string }>(
      `SELECT max(sequence_id)::text AS maximum
       FROM telegram_group_messages WHERE group_id = $1`,
      [group.groupId],
    );
    expect(newest.rows[0]?.maximum).toBe(String(TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES + 1));
  });

  it("removes only a same-family group and cascades its journal and memory", async () => {
    const { familyId, ownerId } = await createOwnedFamily("delete-owner");
    const { familyId: otherFamilyId, ownerId: otherOwnerId } =
      await createOwnedFamily("delete-other");
    const group = await telegramGroupAdministrationRepository.registerGroup({
      familyId,
      messageMode: "all",
      requestedBy: ownerId,
      telegramChatId: "-1001",
      title: "Группа",
      toolAllowlist: [],
      type: "external",
    });
    await telegramGroupJournalRepository.record(group.groupId, message({ id: "1", text: "данные" }));
    await database().query(
      `INSERT INTO memory_items
         (family_id, group_id, scope, author_telegram_user_id, kind, content, source,
          confirmation, sensitivity, operation_key)
       VALUES ($1, $2, 'group', 'delete-owner', 'fact', 'value', 'test',
               'user_confirmed', 'normal', 'delete-group-memory')`,
      [familyId, group.groupId],
    );
    await expect(
      telegramGroupAdministrationRepository.removeRegistration({
        familyId: otherFamilyId,
        requestedBy: otherOwnerId,
        telegramChatId: "-1001",
      }),
    ).rejects.toThrowError(/AGENT_GROUP_NOT_FOUND/);
    await telegramGroupAdministrationRepository.removeRegistration({
      familyId,
      requestedBy: ownerId,
      telegramChatId: "-1001",
    });

    for (const table of [
      "telegram_groups",
      "telegram_group_messages",
      "memory_items",
    ]) {
      const result = await database().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      expect(result.rows[0]?.count).toBe("0");
    }
  });
});
