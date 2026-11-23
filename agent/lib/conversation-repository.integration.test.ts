/**
 * Stable application conversation and participant repository integration tests.
 *
 * Constructs covered:
 * - Group chat lookup returns one stable conversation independent of forum topic metadata.
 * - Participant synchronization trusts Telegram user IDs and exact user links, never usernames.
 * - Opaque participant refs remain local to their origin conversation.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { conversationRepository } from "./conversation-repository.js";
import { conversationTimelineRepository } from "./conversation-timeline-repository.js";
import { closeDatabase, database } from "./database.js";

const describeWithDatabase =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("conversationRepository", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE memory_extraction_batches, claim_evidence, memory_items_all,
         telegram_group_messages, telegram_groups, family_memberships, users, families CASCADE`,
    );
  });

  afterAll(closeDatabase);

  it("synchronizes verified group-local participants without username identity", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Conversation test') RETURNING id",
    );
    const user = await database().query<{ id: string }>(
      `INSERT INTO users (telegram_user_id, display_name, telegram_username)
       VALUES ('501', 'Связанная Анна', 'same_name') RETURNING id`,
    );
    const groups = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, '-100501', 'Первая группа', 'external', 'addressed_only'),
              ($1, '-100502', 'Вторая группа', 'external', 'addressed_only')
       RETURNING id`,
      [family.rows[0]!.id],
    );
    const entries = await database().query<{ id: string }>(
      `INSERT INTO telegram_group_messages
         (group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
          telegram_user_id, sender_username, sender_display_name, sender_is_bot,
          message_kind, content_text, sent_at)
       VALUES ($1, 1, 1, 'user', 'telegram:501', '501', 'same_name', 'Анна', false,
               'text', 'Первое сообщение', now()),
              ($1, 2, 2, 'user', 'telegram:777', '777', 'same_name', 'Другая Анна', false,
               'text', 'Второе сообщение', now()),
              ($1, 3, 3, 'user', 'telegram:501', '501', 'changed_name', 'Анна Новая', false,
               'text', 'Сообщение в теме', now())
       RETURNING id`,
      [groups.rows[0]!.id],
    );

    const conversation = await conversationRepository.getByGroupId(groups.rows[0]!.id);
    const participants = await conversationRepository.syncTimelineParticipants(
      conversation.id,
      entries.rows.map((row) => row.id),
    );

    expect(conversation.scope).toBe("group");
    expect(participants).toHaveLength(2);
    // The username is a display snapshot next to the name, like it, latest observed wins.
    expect(participants.find((item) => item.telegramUserId === "501")).toMatchObject({
      displayNameSnapshot: "Анна Новая",
      linkedUserId: user.rows[0]!.id,
      usernameSnapshot: "changed_name",
    });
    expect(participants.find((item) => item.telegramUserId === "777")).toMatchObject({
      linkedUserId: null,
      usernameSnapshot: "same_name",
    });

    const firstRef = participants[0]!.participantRef;
    const otherConversation = await conversationRepository.getByGroupId(groups.rows[1]!.id);
    await expect(
      conversationRepository.resolveParticipantRef(otherConversation.id, firstRef),
    ).rejects.toThrowError(/AGENT_CONVERSATION_PARTICIPANT_NOT_FOUND/u);
  });

  it("records the Mia display name without changing the stable agent actor ID", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Personal timeline') RETURNING id",
    );
    const user = await database().query<{ id: string }>(
      `INSERT INTO users (telegram_user_id, display_name)
       VALUES ('502', 'Анна') RETURNING id`,
    );
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
      [family.rows[0]!.id, user.rows[0]!.id],
    );
    const conversation = await conversationRepository.getByChatId("502");

    const result = await conversationTimelineRepository.recordAgentResponse({
      applicationSessionId: null,
      contentText: "Готово",
      conversationId: conversation.id,
      deliveredAt: new Date("2026-09-02T09:00:00.000Z"),
      messageThreadId: null,
      replyToEntryId: null,
      telegramMessageIds: ["9001"],
    });
    const stored = await database().query<{
      actor_id: string;
      sender_display_name: string;
    }>("SELECT actor_id, sender_display_name FROM telegram_group_messages WHERE id = $1", [
      result.entryId,
    ]);

    expect(stored.rows[0]).toEqual({
      actor_id: "agent:osinara",
      sender_display_name: "Мия",
    });
  });

  it("pages the personal timeline and marks history left out before the page", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Paged timeline') RETURNING id",
    );
    const user = await database().query<{ id: string }>(
      `INSERT INTO users (telegram_user_id, display_name)
       VALUES ('504', 'Вера') RETURNING id`,
    );
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
      [family.rows[0]!.id, user.rows[0]!.id],
    );
    const conversation = await conversationRepository.getByChatId("504");
    await database().query(
      `INSERT INTO telegram_group_messages
         (conversation_id, sequence_id, actor_kind, actor_id, telegram_message_id,
          sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
       SELECT $1, value, 'agent_self', 'agent:osinara', value, 'Мия', true, 'text', 'seed', now()
       FROM generate_series(1, 5) AS value`,
      [conversation.id],
    );
    const page = (limit: number) =>
      conversationTimelineRepository.listIncremental({
        afterSequence: "1",
        anchorEntryId: null,
        applicationSessionId: "00000000-0000-4000-8000-000000000001",
        beforeSequence: "6",
        conversationId: conversation.id,
        limit,
      });

    const short = await page(2);
    expect(short.entries.map((entry) => entry.sequenceId)).toEqual(["4", "5"]);
    expect(short.omittedBeforeSequence).toBe("4");
    const whole = await page(10);
    expect(whole.entries.map((entry) => entry.sequenceId)).toEqual(["2", "3", "4", "5"]);
    expect(whole.omittedBeforeSequence).toBeNull();
    const recent = await conversationTimelineRepository.listRecent({
      anchorEntryId: null,
      beforeSequence: "6",
      conversationId: conversation.id,
      limit: 3,
    });
    expect(recent.map((entry) => entry.sequenceId)).toEqual(["3", "4", "5"]);
  });

  // The journal keeps every entry, so a reply's target can lie further back than the window: the
  // timeline brings it in from the journal, where a secret was already left out of its text.
  it("brings the current message's reply chain into the personal timeline", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Reply chain') RETURNING id",
    );
    const user = await database().query<{ id: string }>(
      `INSERT INTO users (telegram_user_id, display_name)
       VALUES ('505', 'Глеб') RETURNING id`,
    );
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
      [family.rows[0]!.id, user.rows[0]!.id],
    );
    const conversation = await conversationRepository.getByChatId("505");
    const seeded = await database().query<{ id: string; sequence_id: string }>(
      `INSERT INTO telegram_group_messages
         (conversation_id, sequence_id, actor_kind, actor_id, telegram_message_id,
          sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
       SELECT $1, value, 'agent_self', 'agent:osinara', value, 'Мия', true, 'text', 'seed', now()
       FROM generate_series(1, 7) AS value
       RETURNING id, sequence_id::text`,
      [conversation.id],
    );
    const id = (sequence: string) => seeded.rows.find((row) => row.sequence_id === sequence)!.id;
    // 7 answers 4, 4 answers 3, 3 answers 2, 2 answers 1: the target and two ancestors, not 1.
    for (const [child, parent] of [
      ["7", "4"],
      ["4", "3"],
      ["3", "2"],
      ["2", "1"],
    ] as const) {
      await database().query(
        "UPDATE telegram_group_messages SET reply_to_entry_id = $2 WHERE id = $1",
        [id(child), id(parent)],
      );
    }

    const recent = await conversationTimelineRepository.listRecent({
      anchorEntryId: id("7"),
      beforeSequence: "7",
      conversationId: conversation.id,
      limit: 1,
    });
    expect(recent.map((entry) => entry.sequenceId)).toEqual(["2", "3", "4", "6"]);
    const incremental = await conversationTimelineRepository.listIncremental({
      afterSequence: "5",
      anchorEntryId: id("7"),
      applicationSessionId: "00000000-0000-4000-8000-000000000001",
      beforeSequence: "7",
      conversationId: conversation.id,
      limit: 5,
    });
    expect(incremental.entries.map((entry) => entry.sequenceId)).toEqual(["2", "3", "4", "6"]);
    expect(incremental.omittedBeforeSequence).toBeNull();
  });

  // The timeline had a cap of 10 000 entries per chat until 22 November 2026; it keeps everything.
  it("keeps every personal timeline entry past the old cap", async () => {
    const oldCap = 10_000;
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Long timeline') RETURNING id",
    );
    const user = await database().query<{ id: string }>(
      `INSERT INTO users (telegram_user_id, display_name)
       VALUES ('503', 'Борис') RETURNING id`,
    );
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
      [family.rows[0]!.id, user.rows[0]!.id],
    );
    const conversation = await conversationRepository.getByChatId("503");
    // The next entry's sequence follows the largest one stored, so the seed can go in directly.
    await database().query(
      `INSERT INTO telegram_group_messages
         (conversation_id, sequence_id, actor_kind, actor_id, telegram_message_id,
          sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
       SELECT $1, value, 'agent_self', 'agent:osinara', value, 'Мия', true, 'text', 'seed', now()
       FROM generate_series(1, $2) AS value`,
      [conversation.id, oldCap],
    );
    await conversationTimelineRepository.recordAgentResponse({
      applicationSessionId: null,
      contentText: "новая",
      conversationId: conversation.id,
      deliveredAt: new Date("2026-09-03T09:00:00.000Z"),
      messageThreadId: null,
      replyToEntryId: null,
      telegramMessageIds: [String(oldCap + 1)],
    });

    const kept = await database().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM telegram_group_messages WHERE conversation_id = $1",
      [conversation.id],
    );
    expect(kept.rows[0]?.count).toBe(String(oldCap + 1));
  });
});

describeWithDatabase("conversationRepository.findParticipantByHandle", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE memory_extraction_batches, claim_evidence, memory_items_all,
         telegram_group_messages, telegram_groups, family_memberships, users, families CASCADE`,
    );
  });

  afterAll(closeDatabase);

  it("resolves a handle inside the conversation only, refuses namesakes and treats LIKE characters as text", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Handles') RETURNING id",
    );
    const group = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, '-100601', 'Группа', 'external', 'addressed_only') RETURNING id`,
      [family.rows[0]!.id],
    );
    const entries = await database().query<{ id: string }>(
      `INSERT INTO telegram_group_messages
         (group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
          telegram_user_id, sender_username, sender_display_name, sender_is_bot,
          message_kind, content_text, sent_at)
       VALUES ($1, 1, 1, 'user', 'telegram:601', '601', 'ilya_d', 'Илья', false, 'text', 'раз', now()),
              ($1, 2, 2, 'user', 'telegram:602', '602', 'ilya_k', 'Илья', false, 'text', 'два', now()),
              ($1, 3, 3, 'user', 'telegram:603', '603', 'vadim_k', 'Vadim 100%', false, 'text', 'три', now())
       RETURNING id`,
      [group.rows[0]!.id],
    );
    const conversation = await conversationRepository.getByGroupId(group.rows[0]!.id);
    await conversationRepository.syncTimelineParticipants(
      conversation.id,
      entries.rows.map((row) => row.id),
    );

    await expect(
      conversationRepository.findParticipantByHandle(conversation.id, { displayName: "Илья" }),
    ).resolves.toBeNull();
    await expect(
      conversationRepository.findParticipantByHandle(conversation.id, { username: "@Ilya_D" }),
    ).resolves.toMatchObject({ telegramUserId: "601" });
    await expect(
      conversationRepository.findParticipantByHandle(conversation.id, { telegramUserId: "602" }),
    ).resolves.toMatchObject({ usernameSnapshot: "ilya_k" });
    await expect(
      conversationRepository.findParticipantByHandle(conversation.id, { telegramUserId: "999" }),
    ).resolves.toBeNull();
    await expect(
      conversationRepository.findParticipantByHandle(conversation.id, { displayName: "vad" }),
    ).resolves.toMatchObject({ telegramUserId: "603" });
    await expect(
      conversationRepository.findParticipantByHandle(conversation.id, {
        displayName: "Vadim 100%",
      }),
    ).resolves.toMatchObject({ telegramUserId: "603" });
    await expect(
      conversationRepository.findParticipantByHandle(conversation.id, { displayName: "%" }),
    ).resolves.toBeNull();
    await expect(
      conversationRepository.findParticipantByHandle(conversation.id, { displayName: "_" }),
    ).resolves.toBeNull();
  });
});
