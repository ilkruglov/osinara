/**
 * Turn evaluation repository tests (PostgreSQL).
 *
 * Constructs covered:
 * - The outcome and the delivery of one turn land in one row whichever arrives first.
 * - The summary counts failures, loops, repeats after an error, heavy turns and deliveries, and
 *   groups turns by software version.
 * - A reaction on one of Mia's messages counts by tone; the triggering person's reply to Mia or a
 *   correction phrase within ten minutes counts as a follow-up, a stranger's or a late one does not.
 * - A follow-up counts in a private chat (no group) and only within the turn's forum topic.
 * - A newer reaction replaces an older one; an older one, even of the same second, never
 *   overwrites a newer one.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { turnEvaluationRepository } from "./turn-evaluation-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

const versions = { modelConfigHash: "a".repeat(32), promptHash: "b".repeat(32), softwareVersion: "1.8.35" };
const metrics = { forbiddenTool: false, repeatAfterError: false, repeatedCallRun: 1 };

describeWithDatabase("turnEvaluationRepository", () => {
  let familyId: string;
  let groupId: string;
  const chatId = "-100777";

  beforeEach(async () => {
    await database().query("TRUNCATE turn_evaluations, telegram_message_reactions, users, families CASCADE");
    familyId = (await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Оценка') RETURNING id")).rows[0]!.id;
    groupId = (await database().query<{ id: string }>(
      `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, $2, 'Группа', 'external', 'addressed_only') RETURNING id`,
      [familyId, chatId],
    )).rows[0]!.id;
  });
  afterAll(closeDatabase);

  async function message(input: { id: number; replyTo?: number; sentAt: Date; text: string; userId: string }): Promise<string> {
    const row = await database().query<{ id: string }>(
      `INSERT INTO telegram_group_messages
         (group_id, telegram_message_id, sequence_id, actor_kind, actor_id, telegram_user_id, sender_is_bot,
          message_kind, content_text, reply_to_message_id, sent_at)
       VALUES ($1, $2, $2, 'user', $3, $4, false, 'text', $5, $6, $7) RETURNING id`,
      [groupId, input.id, `telegram:${input.userId}`, input.userId, input.text, input.replyTo ?? null, input.sentAt],
    );
    return row.rows[0]!.id;
  }

  function identity(turn: string, triggeringEntryId: string | null) {
    return { chatKind: "external" as const, eveSessionId: "eve-1", eveTurnId: turn, familyId, telegramChatId: chatId, triggeringEntryId };
  }

  it("merges the outcome and the delivery of a turn and summarizes the window", async () => {
    const start = new Date("2026-10-10T10:00:00.000Z");
    const asked = await message({ id: 1, sentAt: start, text: "Мия, что по шинам?", userId: "501" });
    // Delivery first, then the outcome: the row must keep both.
    await turnEvaluationRepository.recordDelivery(identity("t1", asked), {
      deliveredAt: new Date(start.getTime() + 20_000), replyMessageIds: ["2"], versions,
    });
    await turnEvaluationRepository.recordOutcome(identity("t1", asked), {
      failedToolCount: 0, failureCode: null, finishedAt: new Date(start.getTime() + 21_000), loadedSkills: [],
      metrics: { ...metrics, repeatedCallRun: 3 }, outcome: "completed", stepCount: 4,
      toolCalls: [{ code: null, inputHash: "0".repeat(16), toolName: "web_search" }], versions,
    });
    await turnEvaluationRepository.recordOutcome(identity("t2", null), {
      failedToolCount: 1, failureCode: "MODEL_CALL_FAILED", finishedAt: start, loadedSkills: ["keto-menu"],
      metrics: { ...metrics, repeatAfterError: true }, outcome: "failed", stepCount: 9, toolCalls: [],
      versions: { ...versions, softwareVersion: "1.8.34" },
    });
    // The asker replies to Mia's message and later corrects her; a stranger's reply does not count.
    await message({ id: 3, replyTo: 2, sentAt: new Date(start.getTime() + 60_000), text: "спасибо", userId: "501" });
    await message({ id: 4, sentAt: new Date(start.getTime() + 120_000), text: "не то, я про зимние", userId: "501" });
    await message({ id: 5, replyTo: 2, sentAt: new Date(start.getTime() + 90_000), text: "не так", userId: "999" });
    await message({ id: 6, sentAt: new Date(start.getTime() + 20 * 60_000), text: "неверно", userId: "501" });
    await turnEvaluationRepository.recordReaction({ changedAt: start, emojis: ["👍"], telegramChatId: chatId, telegramMessageId: "2", telegramUserId: "501", updateId: "10" });
    await turnEvaluationRepository.recordReaction({ changedAt: start, emojis: ["🤔", "👎"], telegramChatId: chatId, telegramMessageId: "2", telegramUserId: "999", updateId: "11" });
    await turnEvaluationRepository.recordReaction({ changedAt: start, emojis: ["👍"], telegramChatId: chatId, telegramMessageId: "77", telegramUserId: "501", updateId: "12" });

    const row = await database().query<{ delivered_at: Date | null; outcome: string; reply_message_ids: string[]; step_count: number }>(
      "SELECT outcome, step_count, reply_message_ids, delivered_at FROM turn_evaluations WHERE eve_turn_id = 't1'",
    );
    expect(row.rows[0]).toMatchObject({ outcome: "completed", reply_message_ids: ["2"], step_count: 4 });
    expect(row.rows[0]!.delivered_at).not.toBeNull();

    // Rows are stamped with the time of writing; the window covers both the writes and the deliveries.
    const summary = await turnEvaluationRepository.summary(familyId, new Date(start.getTime() - 60_000), new Date(Date.now() + 3_600_000));
    expect(summary).toEqual({
      delivered: 1,
      failed: 1,
      failedToolTurns: 1,
      followUps: { corrections: 1, repliesToMia: 1 },
      forbiddenTool: 0,
      heavy: 1,
      loops: 1,
      reactions: { negative: 1, other: 1, positive: 1 },
      repeatAfterError: 1,
      turns: 2,
      versions: [{ failed: 1, softwareVersion: "1.8.34", turns: 1 }, { failed: 0, softwareVersion: "1.8.35", turns: 1 }],
    });
  });

  it("counts follow-ups in a private chat and only within the same forum topic", async () => {
    const start = new Date("2026-10-10T14:00:00.000Z");
    const owner = (await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('501', 'Илья') RETURNING id",
    )).rows[0]!.id;
    const conversation = (await database().query<{ id: string }>(
      `INSERT INTO application_conversations (family_id, owner_user_id, telegram_chat_id, scope, scope_partition_key, label)
       VALUES ($1, $2, '501', 'personal', $2, 'Личный чат') RETURNING id`,
      [familyId, owner],
    )).rows[0]!.id;
    const privateEntry = async (id: number, sentAt: Date, text: string) => (await database().query<{ id: string }>(
      `INSERT INTO telegram_group_messages
         (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id, telegram_user_id, sender_is_bot,
          message_kind, content_text, sent_at)
       VALUES ($1, NULL, $2, $2, 'user', 'telegram:501', '501', false, 'text', $3, $4) RETURNING id`,
      [conversation, id, text, sentAt],
    )).rows[0]!.id;
    const asked = await privateEntry(1, start, "Мия, который час?");
    await turnEvaluationRepository.recordDelivery({ ...identity("p1", asked), chatKind: "private", telegramChatId: "501" }, {
      deliveredAt: new Date(start.getTime() + 5_000), replyMessageIds: ["2"], versions,
    });
    await privateEntry(3, new Date(start.getTime() + 30_000), "не так, по Москве");

    // A group turn in topic 7; the same person's correction lands in topic 8.
    const topicEntry = async (id: number, topic: number, sentAt: Date, text: string) => (await database().query<{ id: string }>(
      `INSERT INTO telegram_group_messages
         (group_id, telegram_message_id, message_thread_id, sequence_id, actor_kind, actor_id, telegram_user_id, sender_is_bot,
          message_kind, content_text, sent_at)
       VALUES ($1, $2, $3, $2, 'user', 'telegram:501', '501', false, 'text', $4, $5) RETURNING id`,
      [groupId, id, topic, text, sentAt],
    )).rows[0]!.id;
    const inTopic = await topicEntry(10, 7, start, "Мия, что по шинам?");
    await turnEvaluationRepository.recordDelivery(identity("g1", inTopic), {
      deliveredAt: new Date(start.getTime() + 5_000), replyMessageIds: ["11"], versions,
    });
    await topicEntry(12, 8, new Date(start.getTime() + 30_000), "не так");

    const summary = await turnEvaluationRepository.summary(familyId, new Date(start.getTime() - 60_000), new Date(Date.now() + 3_600_000));
    expect(summary.followUps).toEqual({ corrections: 1, repliesToMia: 0 });
  });

  it("keeps the newest reaction of a person on a message", async () => {
    const later = new Date("2026-10-10T12:00:00.000Z");
    await turnEvaluationRepository.recordReaction({ changedAt: later, emojis: ["❤"], telegramChatId: chatId, telegramMessageId: "9", telegramUserId: "501", updateId: "20" });
    await turnEvaluationRepository.recordReaction({ changedAt: new Date(later.getTime() - 1_000), emojis: ["👎"], telegramChatId: chatId, telegramMessageId: "9", telegramUserId: "501", updateId: "21" });
    // Same second, earlier update: the removal that followed the heart must not be undone (Codex review).
    await turnEvaluationRepository.recordReaction({ changedAt: later, emojis: ["👎"], telegramChatId: chatId, telegramMessageId: "9", telegramUserId: "501", updateId: "19" });
    const stored = await database().query<{ emojis: string[] }>("SELECT emojis FROM telegram_message_reactions WHERE telegram_message_id = 9");
    expect(stored.rows[0]!.emojis).toEqual(["❤"]);
    await turnEvaluationRepository.recordReaction({ changedAt: later, emojis: [], telegramChatId: chatId, telegramMessageId: "9", telegramUserId: "501", updateId: "22" });
    const cleared = await database().query<{ emojis: string[] }>("SELECT emojis FROM telegram_message_reactions WHERE telegram_message_id = 9");
    expect(cleared.rows[0]!.emojis).toEqual([]);
  });
});
