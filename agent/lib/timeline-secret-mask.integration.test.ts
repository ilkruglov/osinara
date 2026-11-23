/**
 * Secrets in the conversation journal, written and read.
 *
 * Constructs covered:
 * - An inbound message that tells a password is stored without text, in a group journal and in a
 *   personal timeline; so is Mia's own answer that repeats one. A key in Mia's answer is masked.
 * - A row stored before these rules is read by them: a key is masked, a card told in words is read
 *   without text, on the group page, the personal page, the history search behind
 *   `list_group_history` and among a silent memory review's sources.
 * - The history search matches only what it shows: a query on a hidden part of an old row finds
 *   nothing, a query on its visible part finds the row masked.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { conversationRepository } from "./conversation-repository.js";
import { conversationTimelineRepository } from "./conversation-timeline-repository.js";
import { closeDatabase, database } from "./database.js";
import { createMainAgentMemoryFixture } from "./memory-agent-write.integration-fixtures.js";
import { observe } from "./memory-review/memory-review-dispatch.integration-fixtures.js";
import { memoryReviewDispatchRepository } from "./memory-review/memory-review-dispatch-repository.js";
import { recordTelegramAgentResponse } from "./telegram-agent-timeline-repository.js";
import { telegramGroupAdministrationRepository } from "./telegram-group-administration-repository.js";
import { recordVerifiedHumanTelegramMessage } from "./telegram-group-journal.integration-fixtures.js";
import { telegramGroupJournalRepository } from "./telegram-group-journal-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
// Each test truncates users and families: only a database named *_test may take that.
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

const OLD_KEY_TEXT = "ключ FAL_KEY=abcdefghij0123456789, не теряй";
const OLD_KEY_MASKED = "ключ FAL_KEY=[СКРЫТО], не теряй";
// The memory policy that filtered old rows did not know a card with its expiry in the same run.
const OLD_CARD_TEXT = "Карта 4242 4242 4242 4242 12/27, оплати";

async function ownedFamily(telegramUserId: string): Promise<{ familyId: string; ownerId: string }> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Секреты') RETURNING id",
  );
  const user = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ($1, 'Анна') RETURNING id",
    [telegramUserId],
  );
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [family.rows[0]!.id, user.rows[0]!.id],
  );
  return { familyId: family.rows[0]!.id, ownerId: user.rows[0]!.id };
}

function inbound(chat: TelegramMessage["chat"], id: string, text: string): TelegramMessage {
  return {
    attachments: [],
    caption: "",
    chat,
    from: { firstName: "Анна", id: "601", isBot: false, username: "anna" },
    messageId: id,
    raw: { date: 1_700_000_000 + Number(id) },
    text,
  };
}

/** The stored text of one journal row; the row itself must exist. */
async function storedText(telegramMessageId: string): Promise<string | null> {
  const row = await database().query<{ content_text: string | null }>(
    "SELECT content_text FROM telegram_group_messages WHERE telegram_message_id = $1",
    [telegramMessageId],
  );
  expect(row.rows).toHaveLength(1);
  return row.rows[0]!.content_text;
}

describeWithDatabase("secrets in the conversation journal", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE invitations, memory_items_all,
         telegram_group_messages, telegram_groups, family_memberships, users, families CASCADE`,
    );
  });

  afterAll(closeDatabase);

  it("stores a group's spoken secrets without text, masks keys, and reads old rows the same way", async () => {
    const { familyId, ownerId } = await ownedFamily("601");
    const { groupId } = await telegramGroupAdministrationRepository.registerGroup({
      familyId,
      messageMode: "all",
      requestedBy: ownerId,
      telegramChatId: "-100601",
      title: "Семья",
      toolAllowlist: [],
      type: "family_private",
    });
    // Rows written before these rules, as production keeps them.
    await database().query(
      `INSERT INTO telegram_group_messages
         (group_id, telegram_message_id, sequence_id, actor_kind, actor_id, telegram_user_id,
          sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
       VALUES ($1, 1, 1, 'user', 'telegram:601', '601', 'Анна', false, 'text', $2, now()),
              ($1, 2, 2, 'user', 'telegram:601', '601', 'Анна', false, 'text', $3, now())`,
      [groupId, OLD_KEY_TEXT, OLD_CARD_TEXT],
    );

    await recordVerifiedHumanTelegramMessage(
      groupId,
      inbound({ id: "-100601", title: "Семья", type: "supergroup" }, "3", "пароль: abcdefgh"),
    );
    for (const [id, contentText] of [
      ["4", "Записала: пароль: abcdefgh12"],
      ["5", "Ключ sk-proj-abcdefgh12 не сохраняю"],
    ] as const) {
      await recordTelegramAgentResponse({
        applicationSessionId: null,
        contentText,
        deliveredAt: new Date(),
        groupId,
        messageThreadId: null,
        replyToEntryId: null,
        telegramMessageIds: [id],
      });
    }

    expect(await storedText("3")).toBeNull();
    expect(await storedText("4")).toBeNull();
    expect(await storedText("5")).toBe("Ключ [СКРЫТО] не сохраняю");
    const page = await telegramGroupJournalRepository.listRecent({
      anchorEntryId: null,
      beforeSequence: null,
      groupId,
      limit: 10,
      messageThreadId: null,
    });
    expect(page.map((entry) => entry.contentText)).toEqual([
      OLD_KEY_MASKED,
      null,
      null,
      null,
      "Ключ [СКРЫТО] не сохраняю",
    ]);
    const search = (query: string | null) =>
      telegramGroupJournalRepository.search({
        allTopics: true,
        anchorEntryId: null,
        beforeSequence: null,
        groupId,
        limit: 10,
        messageThreadId: null,
        query,
      });
    const history = await search(null);
    expect(history.entries.slice(0, 2).map((entry) => entry.contentText)).toEqual([
      OLD_KEY_MASKED,
      null,
    ]);
    // A guess at the start of an old row's key or card confirms nothing.
    expect((await search("abcdefghij")).entries).toEqual([]);
    expect((await search("4242 4242")).entries).toEqual([]);
    const visible = await search("fal_key");
    expect(visible.entries.map((entry) => entry.contentText)).toEqual([OLD_KEY_MASKED]);
  });

  it("stores a personal spoken secret without text, masks a key, and reads old rows the same way", async () => {
    await ownedFamily("601");
    const conversation = await conversationRepository.getByChatId("601");
    await database().query(
      `INSERT INTO telegram_group_messages
         (conversation_id, sequence_id, actor_kind, actor_id, telegram_message_id,
          telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
       VALUES ($1, 1, 'user', 'telegram:601', 1, '601', 'Анна', false, 'text', $2, now()),
              ($1, 2, 'user', 'telegram:601', 2, '601', 'Анна', false, 'text', $3, now())`,
      [conversation.id, OLD_KEY_TEXT, OLD_CARD_TEXT],
    );

    await conversationTimelineRepository.recordInbound(
      conversation.id,
      inbound({ id: "601", type: "private" }, "3", "Пароль: correct-horse-battery-staple"),
    );
    for (const [id, contentText] of [
      ["4", "Пароль: correct-horse-battery-staple, запомнила"],
      ["5", "Твой ключ sk-proj-abcdefgh12 сохранён не будет"],
    ] as const) {
      await conversationTimelineRepository.recordAgentResponse({
        applicationSessionId: null,
        contentText,
        conversationId: conversation.id,
        deliveredAt: new Date(),
        messageThreadId: null,
        replyToEntryId: null,
        telegramMessageIds: [id],
      });
    }

    expect(await storedText("3")).toBeNull();
    expect(await storedText("4")).toBeNull();
    expect(await storedText("5")).toBe("Твой ключ [СКРЫТО] сохранён не будет");
    const page = await conversationTimelineRepository.listRecent({
      anchorEntryId: null,
      beforeSequence: "100",
      conversationId: conversation.id,
      limit: 10,
    });
    expect(page.map((entry) => entry.contentText)).toEqual([
      OLD_KEY_MASKED,
      null,
      null,
      null,
      "Твой ключ [СКРЫТО] сохранён не будет",
    ]);
  });

  it("reads old rows among a silent memory review's sources by the same rules", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await observe(fixture, 2, 51);
    for (const [sequence, text] of [
      [2, OLD_KEY_TEXT],
      [3, OLD_CARD_TEXT],
    ] as const) {
      await database().query(
        `UPDATE telegram_group_messages SET content_text = $3
         WHERE conversation_id = $1 AND sequence_id = $2`,
        [fixture.conversationId, sequence, text],
      );
    }

    const [claim] = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 1,
      now: new Date(),
    });

    const text = (sequence: string) =>
      claim?.entries.find((entry) => entry.sequenceId === sequence)?.contentText;
    expect(text("2")).toBe(OLD_KEY_MASKED);
    expect(text("3")).toBeNull();
    expect(claim?.prompt).not.toContain("abcdefghij0123456789");
    expect(claim?.prompt).not.toContain("4242");
  });
});
