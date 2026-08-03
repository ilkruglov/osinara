/**
 * PostgreSQL scheduled agent scenario lifecycle integration tests.
 *
 * Constructs covered:
 * - Scoped CRUD and destination authorization.
 * - Handoff-only leases, atomic delivered completion, recurrence, and ambiguous recovery.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { agentScheduleDispatchRepository } from "./agent-schedule-dispatch-repository.js";
import { agentScheduleRepository } from "./agent-schedule-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

interface Fixture {
  familyId: string;
  groupId: string;
  memberId: string;
  ownerId: string;
}

async function createFixture(): Promise<Fixture> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Agent schedules') RETURNING id",
  );
  const users = await database().query<{ id: string; telegram_user_id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ('schedule-owner', 'Владелец'), ('schedule-member', 'Участник')
     RETURNING id, telegram_user_id`,
  );
  const ownerId = users.rows.find((row) => row.telegram_user_id === "schedule-owner")!.id;
  const memberId = users.rows.find((row) => row.telegram_user_id === "schedule-member")!.id;
  await database().query(
    `INSERT INTO family_memberships (family_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
    [family.rows[0]!.id, ownerId, memberId],
  );
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, '-100-agent-schedules', 'Семья', 'family_private', 'addressed_only')
     RETURNING id`,
    [family.rows[0]!.id],
  );
  return { familyId: family.rows[0]!.id, groupId: group.rows[0]!.id, memberId, ownerId };
}

function privateAuth(fixture: Fixture, user: "member" | "owner") {
  const owner = user === "owner";
  return {
    familyId: fixture.familyId,
    forumTopicId: null,
    groupId: null,
    groupType: null,
    messageThreadId: null,
    role: owner ? "owner" as const : "member" as const,
    telegramChatId: owner ? "schedule-owner" : "schedule-member",
    telegramChatType: "private" as const,
    telegramUserId: owner ? "schedule-owner" : "schedule-member",
    userId: owner ? fixture.ownerId : fixture.memberId,
  };
}

function familyAuth(fixture: Fixture, user: "member" | "owner") {
  const base = privateAuth(fixture, user);
  return {
    ...base,
    groupId: fixture.groupId,
    forumTopicId: "88",
    groupType: "family_private" as const,
    messageThreadId: "88",
    telegramChatId: "-100-agent-schedules",
    telegramChatType: "supergroup" as const,
  };
}

describeWithDatabase("agent schedule repositories", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE proactive_deliveries, agent_schedule_operations, agent_schedule_runs, agent_schedules,
       conversation_session_routes, conversation_sessions, telegram_groups,
       family_memberships, users, families CASCADE`,
    );
  });
  afterAll(async () => closeDatabase());

  it("creates and lists a personal scheduled agent scenario", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");

    const schedule = await agentScheduleRepository.create(auth, {
      firstRunAt: new Date("2026-07-17T06:00:00.000Z"),
      operationKey: "create-personal-news",
      recurrence: { daysOfWeek: [1, 2, 3, 4, 5], interval: 1, kind: "weekly" },
      scenarioPrompt: "Собрать сводку новостей по ИИ и прислать 5 пунктов.",
      scope: "personal",
      timezone: "Europe/Moscow",
      title: "Новости ИИ",
      userRequest: "Каждый будний день присылай новости по ИИ",
    });

    expect(schedule).toMatchObject({
      recurrence: { daysOfWeek: [1, 2, 3, 4, 5], interval: 1, kind: "weekly" },
      scope: "personal",
      status: "active",
      title: "Новости ИИ",
    });
    await expect(agentScheduleRepository.list(auth)).resolves.toEqual([schedule]);
    await expect(agentScheduleRepository.findById(auth, schedule.id)).resolves.toEqual(schedule);
    await expect(
      agentScheduleRepository.findById(privateAuth(fixture, "owner"), schedule.id),
    ).resolves.toBeNull();
  });

  it("requires a verified family group destination for family schedules", async () => {
    const fixture = await createFixture();

    await expect(agentScheduleRepository.create(privateAuth(fixture, "owner"), {
      firstRunAt: new Date("2026-07-17T06:00:00.000Z"),
      operationKey: "bad-family-destination",
      recurrence: { interval: 1, kind: "daily" },
      scenarioPrompt: "Собрать семейную сводку.",
      scope: "family",
      timezone: "Europe/Moscow",
      title: "Семейная сводка",
      userRequest: "Присылай семье сводку",
    })).rejects.toThrowError(/AGENT_SCHEDULE_DESTINATION_INVALID/);

    await expect(agentScheduleRepository.create(familyAuth(fixture, "owner"), {
      firstRunAt: new Date("2026-07-17T06:00:00.000Z"),
      operationKey: "good-family-destination",
      recurrence: { interval: 1, kind: "daily" },
      scenarioPrompt: "Собрать семейную сводку.",
      scope: "family",
      timezone: "Europe/Moscow",
      title: "Семейная сводка",
      userRequest: "Присылай семье сводку",
    })).resolves.toMatchObject({ scope: "family" });
  });

  it("claims a weekday schedule once and advances it after Eve completion", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");
    await agentScheduleRepository.create(auth, {
      firstRunAt: new Date("2026-07-17T09:00:00.000Z"),
      operationKey: "weekday-created",
      recurrence: { daysOfWeek: [1, 2, 3, 4, 5], interval: 1, kind: "weekly" },
      scenarioPrompt: "Сделать будничную сводку.",
      scope: "personal",
      timezone: "UTC",
      title: "Будничная сводка",
      userRequest: "Каждый будний день присылай сводку",
    });

    const [claimed] = await agentScheduleDispatchRepository.claimDue({
      leaseMilliseconds: 300_000,
      limit: 10,
      now: new Date("2026-07-17T09:00:01.000Z"),
    });
    expect(claimed).toMatchObject({ telegramChatId: "schedule-member", title: "Будничная сводка" });
    await expect(agentScheduleDispatchRepository.claimDue({
      leaseMilliseconds: 300_000,
      limit: 10,
      now: new Date("2026-07-17T09:00:02.000Z"),
    })).resolves.toEqual([]);

    await agentScheduleDispatchRepository.markDispatchStarted(claimed!);
    const prepared = await sessionRepository.prepareTurn({
      baseContinuationToken: "schedule-member::schedule:test-run",
      kind: "scheduled",
      telegramForumTopicId: null,
      familyId: fixture.familyId,
      groupId: null,
      now: new Date("2026-07-17T09:00:01.000Z"),
      scope: "personal",
      userId: fixture.memberId,
    });
    await agentScheduleDispatchRepository.markRunning(claimed!, {
      applicationSessionId: prepared.id,
      eveSessionId: "eve-schedule-1",
    });
    const delivery = {
      applicationSessionId: prepared.id,
      content: "Будничная сводка готова",
      deliveredAt: new Date("2026-07-17T09:01:00.000Z"),
      eveSessionId: "eve-schedule-1",
      familyId: fixture.familyId,
      groupId: null,
      messageThreadId: null,
      ownerUserId: fixture.memberId,
      runId: claimed!.runId,
      scheduledFor: new Date(claimed!.nextRunAt),
      scope: "personal",
      telegramChatId: claimed!.telegramChatId,
      telegramMessageId: "501",
      title: claimed!.title,
    } as const;

    // An unknown run cannot create an orphan receipt or finalize another schedule.
    await expect(agentScheduleDispatchRepository.completeDeliveredRun({
      ...delivery,
      runId: "00000000-0000-4000-8000-000000000999",
    })).rejects.toMatchObject({ code: "AGENT_SCHEDULE_DELIVERY_STATE_INVALID" });
    await expect(database().query("SELECT 1 FROM proactive_deliveries")).resolves.toMatchObject({
      rowCount: 0,
    });

    // Once Telegram delivery belongs to a durable run, retain the receipt despite identity conflict.
    await expect(agentScheduleDispatchRepository.completeDeliveredRun({
      ...delivery,
      eveSessionId: "eve-schedule-conflict",
    })).rejects.toMatchObject({ code: "AGENT_SCHEDULE_DELIVERY_STATE_INVALID" });
    await expect(database().query("SELECT 1 FROM proactive_deliveries")).resolves.toMatchObject({
      rowCount: 1,
    });

    await expect(agentScheduleDispatchRepository.completeDeliveredRun(delivery)).resolves.toBe(true);
    await expect(agentScheduleDispatchRepository.completeDeliveredRun(delivery)).resolves.toBe(false);

    await expect(agentScheduleRepository.list(auth)).resolves.toEqual([
      expect.objectContaining({ nextRunAt: "2026-07-20T09:00:00.000Z", status: "active" }),
    ]);
    await expect(database().query(
      "SELECT source_id::text, telegram_message_id::text FROM proactive_deliveries",
    )).resolves.toMatchObject({
      rows: [{ source_id: claimed!.runId, telegram_message_id: "501" }],
    });
  });

  it("reclaims an expired pre-handoff lease without duplicating the scheduled occurrence", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");
    await agentScheduleRepository.create(auth, {
      firstRunAt: new Date("2026-07-17T09:00:00.000Z"),
      operationKey: "recoverable-created",
      recurrence: { kind: "once" },
      scenarioPrompt: "Запустить после безопасного восстановления lease.",
      scope: "personal",
      timezone: "UTC",
      title: "Восстановимый запуск",
      userRequest: "Запусти один раз",
    });

    const [claimed] = await agentScheduleDispatchRepository.claimDue({
      leaseMilliseconds: 1_000,
      limit: 1,
      now: new Date("2026-07-17T09:00:00.000Z"),
    });
    const [reclaimed] = await agentScheduleDispatchRepository.claimDue({
      leaseMilliseconds: 1_000,
      limit: 1,
      now: new Date("2026-07-17T09:00:02.000Z"),
    });

    expect(reclaimed).toMatchObject({ runId: claimed!.runId, title: "Восстановимый запуск" });
    expect(reclaimed!.leaseToken).not.toBe(claimed!.leaseToken);

    await agentScheduleDispatchRepository.markDispatchStarted(reclaimed!);
    const prepared = await sessionRepository.prepareTurn({
      baseContinuationToken: "schedule-member::schedule:recoverable-run",
      kind: "scheduled",
      telegramForumTopicId: null,
      familyId: fixture.familyId,
      groupId: null,
      now: new Date("2026-07-17T09:00:02.000Z"),
      scope: "personal",
      userId: fixture.memberId,
    });
    await agentScheduleDispatchRepository.markRunning(reclaimed!, {
      applicationSessionId: prepared.id,
      eveSessionId: "eve-schedule-recovered",
    });
    await agentScheduleDispatchRepository.completeDeliveredRun({
      applicationSessionId: prepared.id,
      content: "Одноразовый результат",
      deliveredAt: new Date("2026-07-17T09:01:00.000Z"),
      eveSessionId: "eve-schedule-recovered",
      familyId: fixture.familyId,
      groupId: null,
      messageThreadId: null,
      ownerUserId: fixture.memberId,
      runId: reclaimed!.runId,
      scheduledFor: new Date(reclaimed!.nextRunAt),
      scope: "personal",
      telegramChatId: reclaimed!.telegramChatId,
      telegramMessageId: "502",
      title: reclaimed!.title,
    });

    await expect(agentScheduleRepository.list(auth)).resolves.toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
  });

  it("does not expire a running scenario with its short handoff lease", async () => {
    const fixture = await createFixture();
    await agentScheduleRepository.create(privateAuth(fixture, "member"), {
      firstRunAt: new Date("2026-07-17T09:00:00.000Z"),
      operationKey: "long-running-created",
      recurrence: { kind: "once" },
      scenarioPrompt: "Подготовить подробную сводку.",
      scope: "personal",
      timezone: "UTC",
      title: "Долгий запуск",
      userRequest: "Подготовь подробную сводку",
    });
    const [claimed] = await agentScheduleDispatchRepository.claimDue({
      leaseMilliseconds: 1_000,
      limit: 1,
      now: new Date("2026-07-17T09:00:00.000Z"),
    });
    await agentScheduleDispatchRepository.markDispatchStarted(claimed!);
    const prepared = await sessionRepository.prepareTurn({
      baseContinuationToken: "schedule-member::schedule:long-running",
      kind: "scheduled",
      telegramForumTopicId: null,
      familyId: fixture.familyId,
      groupId: null,
      now: new Date("2026-07-17T09:00:00.000Z"),
      scope: "personal",
      userId: fixture.memberId,
    });

    await agentScheduleDispatchRepository.markRunning(claimed!, {
      applicationSessionId: prepared.id,
      eveSessionId: "eve-schedule-long-running",
    });

    await expect(agentScheduleDispatchRepository.claimDue({
      leaseMilliseconds: 1_000,
      limit: 1,
      now: new Date("2026-07-17T09:00:02.000Z"),
    })).resolves.toEqual([]);
    await expect(agentScheduleRepository.list(privateAuth(fixture, "member"))).resolves.toEqual([
      expect.objectContaining({ lastErrorCode: null, status: "leased" }),
    ]);
  });

  it("does not retry an expired lease after Eve handoff may have started", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");
    await agentScheduleRepository.create(auth, {
      firstRunAt: new Date("2026-07-17T09:00:00.000Z"),
      operationKey: "ambiguous-created",
      recurrence: { kind: "once" },
      scenarioPrompt: "Не продублировать запуск.",
      scope: "personal",
      timezone: "UTC",
      title: "Одноразовый запуск",
      userRequest: "Запусти один раз",
    });
    const [claimed] = await agentScheduleDispatchRepository.claimDue({
      leaseMilliseconds: 1_000,
      limit: 1,
      now: new Date("2026-07-17T09:00:00.000Z"),
    });
    await agentScheduleDispatchRepository.markDispatchStarted(claimed!);

    await expect(agentScheduleDispatchRepository.claimDue({
      leaseMilliseconds: 1_000,
      limit: 1,
      now: new Date("2026-07-17T09:00:02.000Z"),
    })).resolves.toEqual([]);
    await expect(agentScheduleRepository.list(auth)).resolves.toEqual([
      expect.objectContaining({ lastErrorCode: "AGENT_SCHEDULE_DELIVERY_AMBIGUOUS", status: "failed" }),
    ]);
    const run = await database().query<{ error_code: string | null; status: string }>(
      "SELECT status, error_code FROM agent_schedule_runs WHERE schedule_id = $1",
      [claimed!.id],
    );
    expect(run.rows).toEqual([
      { error_code: "AGENT_SCHEDULE_DELIVERY_AMBIGUOUS", status: "ambiguous" },
    ]);
  });
});
