/**
 * Scheduled external-group history snapshot PostgreSQL integration tests.
 *
 * Constructs covered:
 * - A claimed owner-approved external schedule reads one fixed retained-history window.
 * - Subsequent timeline writes cannot change already materialized chunks.
 * - Terminal failure removes run-bound snapshot data.
 * - Entries are stored by the journal's secret rules: a key masked, a card told in words without
 *   text; a long entry is masked before it is cut, so no part shows a key's tail or a part of an
 *   entry that tells a password (22 November 2026).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { agentScheduleDispatchRepository } from "./agent-schedule-dispatch-repository.js";
import { externalAgentScheduleRepository } from "./external-agent-schedule-repository.js";
import { scheduledGroupHistorySnapshotRepository } from "./scheduled-group-history-snapshot-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

async function createClaimedSchedule() {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('History snapshot') RETURNING id",
  );
  const owner = await database().query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ('history-schedule-owner', 'Владелец') RETURNING id`,
  );
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [family.rows[0]!.id, owner.rows[0]!.id],
  );
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, telegram_chat_type, title, type, message_mode)
     VALUES ($1, '-100-history-snapshot', 'supergroup', 'История', 'external', 'all')
     RETURNING id`,
    [family.rows[0]!.id],
  );
  const scheduledFor = new Date("2026-08-17T06:00:00.000Z");
  await externalAgentScheduleRepository.create(
    { familyId: family.rows[0]!.id, requestedBy: owner.rows[0]!.id },
    {
      capabilityAllowlist: [],
      firstRunAt: scheduledFor,
      historyWindowDays: 7,
      operationKey: "create-history-snapshot",
      recurrence: { kind: "once" },
      scenarioPrompt: "Прочитай весь snapshot и подготовь выжимку.",
      telegramChatId: "-100-history-snapshot",
      timezone: "Europe/Moscow",
      title: "Выжимка",
      userRequest: "Подготовь выжимку обсуждения за неделю",
    },
  );
  const jobs = await agentScheduleDispatchRepository.claimDue({
    leaseMilliseconds: 60_000,
    limit: 1,
    now: scheduledFor,
  });
  const session = await sessionRepository.prepareTurn({
    baseContinuationToken: "scheduled-history-snapshot",
    familyId: family.rows[0]!.id,
    groupId: group.rows[0]!.id,
    kind: "scheduled",
    now: scheduledFor,
    scope: "group",
    telegramForumTopicId: null,
    userId: null,
  });
  return { groupId: group.rows[0]!.id, job: jobs[0]!, scheduledFor, sessionId: session.id };
}

async function readAllTimelines(groupId: string, runId: string): Promise<string[]> {
  const timelines: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const chunk = await scheduledGroupHistorySnapshotRepository.readChunk({
      cursor,
      groupId,
      runId,
    });
    timelines.push(chunk.timeline);
    if (chunk.done) return timelines;
    cursor = chunk.nextCursor;
  }
}

async function insertTimelineEntry(input: {
  content: string;
  groupId: string;
  sequence: number;
  sentAt: Date;
}): Promise<void> {
  await database().query(
    `INSERT INTO telegram_group_messages
       (group_id, telegram_message_id, telegram_user_id, sender_display_name,
        sender_is_bot, message_kind, content_text, sent_at, sequence_id, actor_kind, actor_id)
     VALUES ($1, $2, 'history-user', 'Участник', false, 'text', $3, $4, $2, 'user',
             'telegram:history-user')`,
    [input.groupId, input.sequence, input.content, input.sentAt],
  );
}

describeWithDatabase("scheduled group history snapshot repository", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE proactive_deliveries, agent_schedule_operations, agent_schedule_runs,
       agent_schedules, conversation_session_routes, conversation_sessions, telegram_groups,
       family_memberships, users, families CASCADE`,
    );
  });
  afterAll(async () => closeDatabase());

  it("freezes retained history and removes the snapshot when the run fails", async () => {
    const { groupId, job, scheduledFor, sessionId } = await createClaimedSchedule();
    await insertTimelineEntry({
      content: "Сообщение до snapshot",
      groupId,
      sentAt: new Date("2026-08-16T08:00:00.000Z"),
      sequence: 1,
    });

    await expect(
      scheduledGroupHistorySnapshotRepository.prepare({
        groupId,
        runId: job.runId,
        scheduleId: job.id,
      }),
    ).resolves.toMatchObject({ chunkCount: 1, entryCount: 1 });
    await insertTimelineEntry({
      content: "Поздняя запись с временем внутри окна",
      groupId,
      sentAt: new Date("2026-08-16T09:00:00.000Z"),
      sequence: 2,
    });
    await agentScheduleDispatchRepository.markDispatchStarted(job, {
      applicationSessionId: sessionId,
    });

    const chunk = await scheduledGroupHistorySnapshotRepository.readChunk({
      cursor: null,
      groupId,
      runId: job.runId,
    });
    expect(chunk).toMatchObject({ done: true, entryCount: 1, nextCursor: null });
    expect(chunk.timeline).toContain("Сообщение до snapshot");
    expect(chunk.timeline).not.toContain("Поздняя запись");

    await agentScheduleDispatchRepository.failClaim(job, "AGENT_SCHEDULE_TEST_TERMINAL_FAILURE");
    const persisted = await database().query(
      "SELECT 1 FROM agent_schedule_history_snapshots WHERE run_id = $1",
      [job.runId],
    );
    expect(persisted.rowCount).toBe(0);
    expect(scheduledFor.toISOString()).toBe(job.nextRunAt);
  });

  it("stores chunks by the journal's secret rules", async () => {
    const { groupId, job, sessionId } = await createClaimedSchedule();
    for (const [sequence, content] of [
      [1, "ключ FAL_KEY=abcdefghij0123456789, не теряй"],
      [2, "Карта 4242 4242 4242 4242 12/27, оплати"],
    ] as const) {
      await insertTimelineEntry({
        content,
        groupId,
        sentAt: new Date(`2026-08-16T0${sequence}:00:00.000Z`),
        sequence,
      });
    }
    await scheduledGroupHistorySnapshotRepository.prepare({
      groupId,
      runId: job.runId,
      scheduleId: job.id,
    });
    await agentScheduleDispatchRepository.markDispatchStarted(job, {
      applicationSessionId: sessionId,
    });

    const stored = await database().query<{ entries: { content: string | null }[] }>(
      "SELECT entries FROM agent_schedule_history_chunks WHERE run_id = $1",
      [job.runId],
    );
    expect(stored.rows[0]?.entries.map((entry) => entry.content)).toEqual([
      "ключ FAL_KEY=[СКРЫТО], не теряй",
      null,
    ]);
    const chunk = await scheduledGroupHistorySnapshotRepository.readChunk({
      cursor: null,
      groupId,
      runId: job.runId,
    });
    expect(chunk.timeline).toContain("ключ FAL_KEY=[СКРЫТО], не теряй");
    expect(chunk.timeline).not.toContain("abcdefghij");
    expect(chunk.timeline).not.toContain("4242");
  });

  it("hides a secret of a long entry in every part it is cut into", async () => {
    const { groupId, job, sessionId } = await createClaimedSchedule();
    const pemLine = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj";
    // About 9 750 characters of key: the cut of a 9 000-character chunk falls inside it.
    const pem = `-----BEGIN PRIVATE KEY-----\n${Array.from({ length: 150 }, () => pemLine).join("\n")}\n-----END PRIVATE KEY-----`;
    for (const [sequence, content] of [
      [1, `Ключи сервера, не теряй:\n${pem}\nпосле ключа`],
      [2, `${"Рассказ про дачу и грядки. ".repeat(400)}Вайфай на даче, пароль: Qwerty-12345`],
      [3, "Обычное сообщение"],
    ] as const) {
      await insertTimelineEntry({
        content,
        groupId,
        sentAt: new Date(`2026-08-16T0${sequence}:00:00.000Z`),
        sequence,
      });
    }
    await scheduledGroupHistorySnapshotRepository.prepare({
      groupId,
      runId: job.runId,
      scheduleId: job.id,
    });
    await agentScheduleDispatchRepository.markDispatchStarted(job, {
      applicationSessionId: sessionId,
    });

    const timelines = await readAllTimelines(groupId, job.runId);
    const all = timelines.join("\n");
    expect(all).toContain("после ключа");
    expect(all).toContain("Обычное сообщение");
    for (const timeline of timelines) {
      expect(timeline).not.toContain(pemLine);
      expect(timeline).not.toContain("Рассказ про дачу");
      expect(timeline).not.toContain("Qwerty");
    }
  });

  it("cleans a recovered pre-handoff snapshot when owner authorization was revoked", async () => {
    const { groupId, job, scheduledFor } = await createClaimedSchedule();
    await scheduledGroupHistorySnapshotRepository.prepare({
      groupId,
      runId: job.runId,
      scheduleId: job.id,
    });
    await database().query("UPDATE family_memberships SET role = 'member'");

    await expect(
      agentScheduleDispatchRepository.claimDue({
        leaseMilliseconds: 60_000,
        limit: 1,
        now: new Date(scheduledFor.getTime() + 61_000),
      }),
    ).resolves.toEqual([]);
    await expect(
      database().query("SELECT 1 FROM agent_schedule_history_snapshots WHERE run_id = $1", [
        job.runId,
      ]),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(
      database().query("SELECT status::text, error_code FROM agent_schedule_runs WHERE id = $1", [
        job.runId,
      ]),
    ).resolves.toMatchObject({
      rows: [{ error_code: "AGENT_SCHEDULE_DESTINATION_REVOKED", status: "failed" }],
    });
  });
});
