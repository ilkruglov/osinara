/**
 * PostgreSQL external-group reminder integration tests.
 *
 * Constructs covered:
 * - Telegram-authored group reminders in the fixed public-chat timezone.
 * - Per-author and per-chat live caps, counted over live reminders only.
 * - Author-only mutation, chat-wide listing of upcoming reminders and own paused ones.
 * - Dispatch claims a group reminder, ignores personal quiet hours and revokes a changed zone.
 * - The trusted private-chat boundary never reaches a reminder of a public chat.
 * - Caps hold across pausing and revival, and no anchor may sit far in the past.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import {
  GROUP_REMINDER_MAX_PER_AUTHOR,
  GROUP_REMINDER_MAX_PER_CHAT,
  GROUP_REMINDER_TIMEZONE,
} from "./reminder-config.js";
import type { GroupReminderAuthorization } from "./group-reminder-context.js";
import { groupReminderRepository } from "./group-reminder-repository.js";
import { reminderDispatchRepository } from "./reminder-dispatch-repository.js";
import { reminderRepository } from "./reminder-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

const FIRST_AUTHOR = "5001";
const SECOND_AUTHOR = "5002";

// One test registers a second public chat, so every fixture needs its own Telegram identifiers.
let fixtureIndex = 0;

interface Fixture {
  chatId: string;
  familyId: string;
  groupId: string;
  ownerId: string;
  ownerTelegramUserId: string;
}

async function createFixture(): Promise<Fixture> {
  fixtureIndex += 1;
  const chatId = `-100-external-reminders-${fixtureIndex}`;
  const ownerTelegramUserId = `900${fixtureIndex}`;
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Внешние напоминания') RETURNING id",
  );
  const familyId = family.rows[0]!.id;
  const owner = await database().query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ($1, 'Владелец') RETURNING id`,
    [ownerTelegramUserId],
  );
  const ownerId = owner.rows[0]!.id;
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [familyId, ownerId],
  );
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, $2, 'Публичный чат', 'external', 'addressed_only')
     RETURNING id`,
    [familyId, chatId],
  );
  return { chatId, familyId, groupId: group.rows[0]!.id, ownerId, ownerTelegramUserId };
}

function groupAuth(fixture: Fixture, telegramUserId: string): GroupReminderAuthorization {
  return {
    familyId: fixture.familyId,
    groupId: fixture.groupId,
    telegramChatId: fixture.chatId,
    telegramUserId,
  };
}

function ownerPrivateAuth(fixture: Fixture) {
  return {
    familyId: fixture.familyId,
    forumTopicId: null,
    groupId: null,
    groupType: null,
    messageThreadId: null,
    role: "owner" as const,
    telegramChatId: fixture.ownerTelegramUserId,
    telegramChatType: "private" as const,
    userId: fixture.ownerId,
  };
}

async function create(
  fixture: Fixture,
  telegramUserId: string,
  content: string,
  firstRunAt: string,
  operationKey: string,
) {
  return await groupReminderRepository.create(groupAuth(fixture, telegramUserId), {
    content,
    firstRunAt: new Date(firstRunAt),
    operationKey,
    recurrence: null,
  });
}

describeWithDatabase("group reminder repository", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE reminders, user_notification_settings, telegram_groups, family_memberships, users, families CASCADE",
    );
  });
  afterAll(async () => closeDatabase());

  it("stores a Telegram-authored reminder in the fixed public-chat timezone", async () => {
    const fixture = await createFixture();

    const reminder = await create(
      fixture,
      FIRST_AUTHOR,
      "Созвон по проекту",
      "2026-09-04T15:00:00.000Z",
      "group-created",
    );

    expect(reminder).toMatchObject({
      content: "Созвон по проекту",
      messageThreadId: null,
      scope: "group",
      status: "active",
      timezone: GROUP_REMINDER_TIMEZONE,
    });
    const row = await database().query<{
      author_telegram_user_id: string;
      author_user_id: string | null;
      forum_topic_id: string | null;
      group_id: string;
      owner_user_id: string | null;
    }>(
      `SELECT author_telegram_user_id, author_user_id, forum_topic_id::text, group_id, owner_user_id
       FROM reminders WHERE id = $1`,
      [reminder.id],
    );
    expect(row.rows[0]).toEqual({
      author_telegram_user_id: FIRST_AUTHOR,
      author_user_id: null,
      forum_topic_id: null,
      group_id: fixture.groupId,
      owner_user_id: null,
    });
  });

  it("refuses a chat that is no longer a registered external group", async () => {
    const fixture = await createFixture();
    await database().query("UPDATE telegram_groups SET type = 'family_private' WHERE id = $1", [
      fixture.groupId,
    ]);

    await expect(create(fixture, FIRST_AUTHOR, "Не должно создаться", "2026-09-04T15:00:00.000Z", "wrong-zone"))
      .rejects.toThrowError(/AGENT_REMINDER_DESTINATION_INVALID/);
  });

  it("caps live reminders per author while another participant keeps its own quota", async () => {
    const fixture = await createFixture();
    for (let index = 0; index < GROUP_REMINDER_MAX_PER_AUTHOR; index += 1) {
      await create(fixture, FIRST_AUTHOR, `Задача ${index}`, "2026-09-04T15:00:00.000Z", `mine-${index}`);
    }

    await expect(create(fixture, FIRST_AUTHOR, "Лишнее", "2026-09-04T15:00:00.000Z", "mine-extra"))
      .rejects.toThrowError(/AGENT_REMINDER_GROUP_AUTHOR_LIMIT/);
    await expect(create(fixture, SECOND_AUTHOR, "Своё", "2026-09-04T15:00:00.000Z", "other-1"))
      .resolves.toMatchObject({ scope: "group" });
  });

  it("frees an author slot once a reminder is deleted", async () => {
    const fixture = await createFixture();
    const created = [];
    for (let index = 0; index < GROUP_REMINDER_MAX_PER_AUTHOR; index += 1) {
      created.push(
        await create(fixture, FIRST_AUTHOR, `Задача ${index}`, "2026-09-04T15:00:00.000Z", `slot-${index}`),
      );
    }
    await groupReminderRepository.delete(
      groupAuth(fixture, FIRST_AUTHOR),
      created[0]!.id,
      "slot-delete",
    );

    await expect(create(fixture, FIRST_AUTHOR, "Новое", "2026-09-04T15:00:00.000Z", "slot-refill"))
      .resolves.toMatchObject({ scope: "group" });
  });

  it("caps live reminders per chat across all participants", async () => {
    const fixture = await createFixture();
    for (let index = 0; index < GROUP_REMINDER_MAX_PER_CHAT; index += 1) {
      await database().query(
        `INSERT INTO reminders
           (family_id, author_telegram_user_id, group_id, scope, content, timezone,
            telegram_chat_id, recurrence_anchor_local, due_at, available_at)
         VALUES ($1, $2, $3, 'group', 'Заполнение', $4,
                 $5, timestamp '2026-09-04 18:00', now(), now())`,
        [fixture.familyId, `seed-${index}`, fixture.groupId, GROUP_REMINDER_TIMEZONE, fixture.chatId],
      );
    }

    await expect(create(fixture, FIRST_AUTHOR, "Лишнее", "2026-09-04T15:00:00.000Z", "chat-extra"))
      .rejects.toThrowError(/AGENT_REMINDER_GROUP_CHAT_LIMIT/);
  });

  it("keeps a paused reminder inside the author cap", async () => {
    const fixture = await createFixture();
    const paused = await create(fixture, FIRST_AUTHOR, "На паузе", "2026-09-04T15:00:00.000Z", "cap-paused");
    await groupReminderRepository.update(groupAuth(fixture, FIRST_AUTHOR), paused.id, {
      enabled: false,
      operationKey: "cap-pause",
    });
    for (let index = 1; index < GROUP_REMINDER_MAX_PER_AUTHOR; index += 1) {
      await create(fixture, FIRST_AUTHOR, `Задача ${index}`, "2026-09-04T15:00:00.000Z", `cap-${index}`);
    }

    await expect(create(fixture, FIRST_AUTHOR, "Лишнее", "2026-09-04T15:00:00.000Z", "cap-extra"))
      .rejects.toThrowError(/AGENT_REMINDER_GROUP_AUTHOR_LIMIT/);
  });

  it("re-checks the author cap when a failed reminder is brought back to life", async () => {
    const fixture = await createFixture();
    const revived = await create(fixture, FIRST_AUTHOR, "Упавшее", "2026-09-04T15:00:00.000Z", "revive-created");
    await database().query(
      "UPDATE reminders SET status = 'failed', last_error_code = 'AGENT_REMINDER_TELEGRAM_DELIVERY_FAILED' WHERE id = $1",
      [revived.id],
    );
    for (let index = 0; index < GROUP_REMINDER_MAX_PER_AUTHOR; index += 1) {
      await create(fixture, FIRST_AUTHOR, `Замена ${index}`, "2026-09-04T15:00:00.000Z", `revive-${index}`);
    }

    await expect(groupReminderRepository.update(groupAuth(fixture, FIRST_AUTHOR), revived.id, {
      enabled: true,
      firstRunAt: new Date("2026-09-05T15:00:00.000Z"),
      operationKey: "revive-resume",
    })).rejects.toThrowError(/AGENT_REMINDER_GROUP_AUTHOR_LIMIT/);
  });

  it("refuses to pause a reminder that is no longer running", async () => {
    const fixture = await createFixture();
    const done = await create(fixture, FIRST_AUTHOR, "Уже отправлено", "2026-09-04T15:00:00.000Z", "done-created");
    await database().query("UPDATE reminders SET status = 'completed' WHERE id = $1", [done.id]);

    await expect(groupReminderRepository.update(groupAuth(fixture, FIRST_AUTHOR), done.id, {
      enabled: false,
      operationKey: "done-pause",
    })).rejects.toThrowError(/AGENT_REMINDER_NOT_ACTIVE/);
  });

  it("refuses a first run far in the past, so no anchor can replay missed occurrences", async () => {
    const fixture = await createFixture();

    await expect(create(fixture, FIRST_AUTHOR, "Древнее", "2020-01-01T10:00:00.000Z", "ancient"))
      .rejects.toThrowError(/AGENT_REMINDER_GROUP_TIME_TOO_OLD/);
  });

  it("lists upcoming chat reminders for everyone and paused ones only for their author", async () => {
    const fixture = await createFixture();
    const later = await create(fixture, FIRST_AUTHOR, "Позже", "2026-09-06T15:00:00.000Z", "list-later");
    const sooner = await create(fixture, SECOND_AUTHOR, "Раньше", "2026-09-05T15:00:00.000Z", "list-sooner");
    const paused = await create(fixture, SECOND_AUTHOR, "На паузе", "2026-09-07T15:00:00.000Z", "list-paused");
    await groupReminderRepository.update(groupAuth(fixture, SECOND_AUTHOR), paused.id, {
      enabled: false,
      operationKey: "list-pause",
    });

    const asFirst = await groupReminderRepository.list(groupAuth(fixture, FIRST_AUTHOR), { limit: 100 });
    expect(asFirst.items.map((item) => item.id)).toEqual([sooner.id, later.id]);
    // Authorship is reported, so the agent never offers to change a reminder it cannot change.
    expect(asFirst.items.map((item) => item.mine)).toEqual([false, true]);
    const asSecond = await groupReminderRepository.list(groupAuth(fixture, SECOND_AUTHOR), { limit: 100 });
    expect(asSecond.items.map((item) => item.id)).toEqual([sooner.id, later.id, paused.id]);
    expect(asSecond.items.map((item) => item.mine)).toEqual([true, false, true]);
  });

  it("lets only the author change or delete a group reminder", async () => {
    const fixture = await createFixture();
    const reminder = await create(fixture, FIRST_AUTHOR, "Только моё", "2026-09-04T15:00:00.000Z", "own-created");

    await expect(groupReminderRepository.update(groupAuth(fixture, SECOND_AUTHOR), reminder.id, {
      content: "Чужая правка",
      operationKey: "foreign-update",
    })).rejects.toThrowError(/AGENT_REMINDER_MUTATION_DENIED/);
    await expect(groupReminderRepository.delete(
      groupAuth(fixture, SECOND_AUTHOR),
      reminder.id,
      "foreign-delete",
    )).rejects.toThrowError(/AGENT_REMINDER_MUTATION_DENIED/);
    await expect(groupReminderRepository.update(groupAuth(fixture, FIRST_AUTHOR), reminder.id, {
      content: "Своя правка",
      operationKey: "own-update",
    })).resolves.toMatchObject({ content: "Своя правка" });
    await expect(groupReminderRepository.delete(
      groupAuth(fixture, FIRST_AUTHOR),
      reminder.id,
      "own-delete",
    )).resolves.toBe(true);
  });

  it("never exposes a reminder of another chat to a participant", async () => {
    const fixture = await createFixture();
    const other = await createFixture();
    const reminder = await create(other, FIRST_AUTHOR, "Другой чат", "2026-09-04T15:00:00.000Z", "other-chat");

    await expect(groupReminderRepository.list(groupAuth(fixture, FIRST_AUTHOR), { limit: 100 }))
      .resolves.toEqual({ items: [], nextCursor: null });
    await expect(groupReminderRepository.delete(
      groupAuth(fixture, FIRST_AUTHOR),
      reminder.id,
      "cross-chat-delete",
    )).rejects.toThrowError(/AGENT_REMINDER_NOT_FOUND/);
  });

  it("refuses to let the family owner change a public-chat reminder from a private chat", async () => {
    const fixture = await createFixture();
    const reminder = await create(fixture, FIRST_AUTHOR, "Чужая зона", "2026-09-04T15:00:00.000Z", "owner-reach");

    await expect(reminderRepository.update(ownerPrivateAuth(fixture), reminder.id, {
      content: "Правка владельца",
      operationKey: "owner-update",
    })).rejects.toThrowError(/AGENT_REMINDER_MUTATION_DENIED/);
    await expect(reminderRepository.delete(ownerPrivateAuth(fixture), reminder.id, "owner-delete"))
      .rejects.toThrowError(/AGENT_REMINDER_MUTATION_DENIED/);
    await expect(reminderRepository.list(ownerPrivateAuth(fixture), { limit: 100 }))
      .resolves.toEqual({ items: [], nextCursor: null });
  });

  it("claims a due group reminder and ignores the family owner's quiet hours", async () => {
    const fixture = await createFixture();
    await reminderRepository.configureNotifications(ownerPrivateAuth(fixture), {
      quietEnd: "07:00",
      quietStart: "23:00",
      timezone: GROUP_REMINDER_TIMEZONE,
    });
    const reminder = await create(fixture, FIRST_AUTHOR, "Ночной созвон", "2026-09-04T21:00:00.000Z", "quiet-group");

    const [claimed] = await reminderDispatchRepository.claimDue({
      leaseMilliseconds: 300_000,
      limit: 10,
      now: new Date("2026-09-04T21:00:30.000Z"),
    });

    expect(claimed).toMatchObject({
      delayed: false,
      id: reminder.id,
      messageThreadId: null,
      scope: "group",
      telegramChatId: fixture.chatId,
    });
  });

  it("completes a delivered group reminder and records it as chat-level history", async () => {
    const fixture = await createFixture();
    const reminder = await create(fixture, FIRST_AUTHOR, "Отчёт", "2026-09-04T09:00:00.000Z", "complete-group");
    const [claimed] = await reminderDispatchRepository.claimDue({
      leaseMilliseconds: 300_000,
      limit: 10,
      now: new Date("2026-09-04T09:00:10.000Z"),
    });
    await reminderDispatchRepository.markDispatchStarted(claimed!.id, claimed!.leaseToken);

    await reminderDispatchRepository.complete(
      claimed!,
      new Date("2026-09-04T09:00:11.000Z"),
      { messageId: "9001", text: "Напоминание:\n\nОтчёт" },
    );

    const stored = await database().query<{ status: string }>(
      "SELECT status FROM reminders WHERE id = $1",
      [reminder.id],
    );
    expect(stored.rows[0]).toEqual({ status: "completed" });
    const delivery = await database().query<{ group_id: string; scope: string }>(
      "SELECT group_id, scope FROM proactive_deliveries WHERE source_id = $1",
      [reminder.id],
    );
    expect(delivery.rows[0]).toEqual({ group_id: fixture.groupId, scope: "group" });
  });

  it("fails a group reminder once its chat leaves the external trust zone", async () => {
    const fixture = await createFixture();
    const reminder = await create(fixture, FIRST_AUTHOR, "Отзыв зоны", "2026-09-04T09:00:00.000Z", "revoke-group");
    await database().query("UPDATE telegram_groups SET type = 'family_private' WHERE id = $1", [
      fixture.groupId,
    ]);

    await expect(reminderDispatchRepository.claimDue({
      leaseMilliseconds: 300_000,
      limit: 10,
      now: new Date("2026-09-04T09:00:10.000Z"),
    })).resolves.toEqual([]);
    const stored = await database().query<{ last_error_code: string; status: string }>(
      "SELECT last_error_code, status FROM reminders WHERE id = $1",
      [reminder.id],
    );
    expect(stored.rows[0]).toEqual({
      last_error_code: "AGENT_REMINDER_DESTINATION_REVOKED",
      status: "failed",
    });
  });
});
