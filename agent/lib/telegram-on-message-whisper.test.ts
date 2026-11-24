/**
 * The turn of a whisper in the inbound handler.
 *
 * Constructs covered:
 * - A whisper never enters the group journal or the memory review, and starts a turn in its own
 *   session (group, topic, person), with replies to Mia's messages read as a plain message.
 * - The model sees the recent group timeline read-only and the question in the current envelope;
 *   the auth carries the whisper attributes and none of the timeline-entry attributes a memory
 *   write or a chat reply would rely on.
 * - The group policy is checked again: a whisper the author may no longer send gets its placeholder
 *   removed and no turn.
 * - An ephemeral message without the ingress marker never starts anything.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import { describe, expect, it } from "vitest";

import { TELEGRAM_GROUP_JOURNAL_CONTEXT_CHARACTERS } from "../config.js";

import { createTelegramMessageHandler } from "./telegram-on-message.js";
import { repositories, telegramContext } from "./telegram-on-message.test-fixtures.js";

const MARKER = { ephemeralMessageId: 7, placeholderMessageId: 31, receiverUserId: "101" };

function whisper(text = "/whisper о чём они спорят?", marker: unknown = MARKER): TelegramMessage {
  return {
    attachments: [],
    caption: "",
    chat: { id: "group-101", title: "Группа", type: "supergroup" },
    from: { firstName: "Анна", id: "101", isBot: false, username: "anna" },
    messageId: "0",
    raw: {
      date: 1_700_000_000,
      ephemeral_message_id: 7,
      message_id: 0,
      ...(marker === null ? {} : { osinara_whisper: marker }),
      osinara_update_id: "2001",
      text,
    },
    text,
  };
}

function familyGroup() {
  const repository = repositories();
  repository.telegram.findGroup.mockResolvedValue({
    familyId: "family-1",
    groupId: "group-1",
    messageMode: "addressed_only",
    telegramChatId: "group-101",
    toolAllowlist: [],
    type: "family_private",
  });
  repository.telegram.findIdentity.mockResolvedValue({
    familyId: "family-1",
    role: "member",
    userId: "user-1",
  });
  repository.journal.listRecentPage.mockResolvedValue({
    entries: [
      {
        actorId: "telegram:102",
        actorKind: "user",
        contentText: "Мия, кто прав про отпуск?",
        entryId: "00000000-0000-4000-8000-000000000020",
        messageKind: "text",
        messageThreadId: null,
        replyToSequenceId: null,
        senderDisplayName: "Илья",
        senderUsername: "ilya",
        sentAt: "2026-11-06T18:00:00.000Z",
        sequenceId: "40",
      },
    ],
    omittedBeforeSequence: null,
  });
  return repository;
}

describe("createTelegramMessageHandler whisper", () => {
  it("starts a turn in the whisper's own session without touching the group journal", async () => {
    const repository = familyGroup();
    const handler = createTelegramMessageHandler(repository);

    const result = await handler(telegramContext().context, whisper());

    expect(repository.journal.record).not.toHaveBeenCalled();
    expect(repository.memoryReview.observePassiveMessage).not.toHaveBeenCalled();
    expect(repository.groupContext.prepare).not.toHaveBeenCalled();
    expect(repository.session.prepareTurn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        baseContinuationToken: "osinara:whisper:group-1:main:101",
        familyId: "family-1",
        groupId: "group-1",
        kind: "whisper",
        scope: "family",
        telegramForumTopicId: null,
        userId: null,
      }),
    );
    expect(result).toMatchObject({
      continuationToken: "telegram-101::",
      replyHandling: "message",
    });
    const attributes = result?.auth?.attributes ?? {};
    expect(attributes).toMatchObject({
      applicationSessionId: "session-1",
      familyId: "family-1",
      groupId: "group-1",
      groupType: "family_private",
      memoryScopes: ["family"],
      role: "member",
      telegramActorId: "101",
      telegramActorKind: "telegram_user",
      telegramChatId: "group-101",
      telegramChatType: "supergroup",
      telegramConversationId: "conversation-group-1",
      telegramUserId: "101",
      telegramWhisper: "true",
      telegramWhisperPlaceholderId: "31",
      telegramWhisperReceiverId: "101",
    });
    for (const absent of [
      "telegramMessageId",
      "telegramReplyToMessageId",
      "telegramTimelineEntryId",
      "telegramTimelineSequence",
      "telegramTimelineVisibleEntryIds",
      "osinaraTelegramUpdateId",
    ])
      expect(attributes).not.toHaveProperty(absent);
    expect(result?.message).toContain("Мия, кто прав про отпуск?");
    expect(result?.message).toMatch(
      /<current_telegram_message>\n.*"text":"о чём они спорят\?".*"whisper":true/u,
    );
    expect(repository.whisper.close).not.toHaveBeenCalled();
  });

  // Final review, 22 November 2026: Telegram makes every message of a forum topic a reply to the
  // topic's creation, which has no text; the whisper took it for a reply to a missing message.
  it("does not take a whisper in a forum topic for a reply", async () => {
    const repository = familyGroup();
    const handler = createTelegramMessageHandler(repository);
    const message = whisper();
    const topicMessage: TelegramMessage = {
      ...message,
      messageThreadId: 12,
      raw: {
        ...message.raw,
        is_topic_message: true,
        message_thread_id: 12,
        reply_to_message: {
          chat: { id: "group-101", type: "supergroup" },
          forum_topic_created: { icon_color: 7322096, name: "Отпуск" },
          message_id: 12,
        },
      },
      replyToMessage: {
        chat: { id: "group-101", title: "Группа", type: "supergroup" as const },
        messageId: "12",
      },
    };

    const result = await handler(telegramContext().context, topicMessage);

    expect(result?.message).not.toContain("replyTargetUnavailable");
  });

  // A reply thread outside forum topics carries `message_thread_id` too: only a topic (proved by
  // `is_topic_message`) has a root that is no reply.
  it("still takes a whisper in an ordinary reply thread for a reply", async () => {
    const repository = familyGroup();
    const handler = createTelegramMessageHandler(repository);
    const message = whisper();
    const threaded: TelegramMessage = {
      ...message,
      raw: {
        ...message.raw,
        message_thread_id: 12,
        reply_to_message: {
          chat: { id: "group-101", type: "supergroup" },
          from: { first_name: "Илья", id: 102, is_bot: false },
          message_id: 12,
          sticker: { file_id: "sticker" },
        },
      },
      replyToMessage: {
        chat: { id: "group-101", title: "Группа", type: "supergroup" as const },
        from: { firstName: "Илья", id: "102", isBot: false },
        messageId: "12",
      },
    };

    const result = await handler(telegramContext().context, threaded);

    expect(result?.message).toContain('"replyTargetUnavailable":true');
  });

  it("reads the recent timeline of the whisper's own topic", async () => {
    const repository = familyGroup();
    const handler = createTelegramMessageHandler(repository);
    const message = whisper();
    const topicMessage: TelegramMessage = {
      ...message,
      messageThreadId: 12,
      raw: { ...message.raw, is_topic_message: true, message_thread_id: 12 },
    };

    await handler(telegramContext().context, topicMessage);

    expect(repository.journal.listRecentPage).toHaveBeenCalledWith(
      expect.objectContaining({
        anchorEntryId: null,
        beforeSequence: null,
        groupId: "group-1",
        messageThreadId: "12",
      }),
    );
    expect(repository.session.prepareTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        baseContinuationToken: "osinara:whisper:group-1:topic:12:101",
        telegramForumTopicId: 12,
      }),
    );
  });

  it("removes the placeholder of a whisper the author may no longer send", async () => {
    const repository = familyGroup();
    repository.telegram.findIdentity.mockResolvedValue(null);
    const handler = createTelegramMessageHandler(repository);

    await expect(handler(telegramContext().context, whisper())).resolves.toBeNull();

    expect(repository.whisper.close).toHaveBeenCalledExactlyOnceWith("group-101", MARKER);
    expect(repository.session.prepareTurn).not.toHaveBeenCalled();
    expect(repository.journal.record).not.toHaveBeenCalled();
  });

  it("never starts anything for an ephemeral message without the ingress marker", async () => {
    const repository = familyGroup();
    const handler = createTelegramMessageHandler(repository);

    await expect(
      handler(telegramContext().context, whisper("/whisper привет", null)),
    ).resolves.toBeNull();

    expect(repository.journal.record).not.toHaveBeenCalled();
    expect(repository.session.prepareTurn).not.toHaveBeenCalled();
    expect(repository.whisper.close).not.toHaveBeenCalled();
  });

  it("shows the message the whisper answers, so «что он имел в виду?» has its subject", async () => {
    const repository = familyGroup();
    const handler = createTelegramMessageHandler(repository);
    const message = whisper("/whisper что он имел в виду?");
    const target = {
      chat: { id: "group-101", title: "Группа", type: "supergroup" as const },
      from: { firstName: "Илья", id: "102", isBot: false, username: "ilya" },
      messageId: "77",
    };
    const reply: TelegramMessage = {
      ...message,
      raw: {
        ...message.raw,
        quote: { text: "по-логистически" },
        reply_to_message: {
          chat: { id: "group-101", type: "supergroup" },
          from: { first_name: "Илья", id: 102, is_bot: false, username: "ilya" },
          message_id: 77,
          text: "Ну это решается по-логистически",
        },
      },
      replyToMessage: target,
    };

    const result = await handler(telegramContext().context, reply);

    expect(result?.message).toContain(
      '"replyTargetSnapshot":{"contentText":"Ну это решается по-логистически","senderDisplayName":"Илья","senderUsername":"ilya"}',
    );
    expect(result?.message).toContain('"replyQuotedText":"по-логистически"');
  });

  // Final review, 22 November 2026: a reply whose target has no usable text said nothing about
  // being a reply, and an oversized target and fragment failed the whisper.
  it.each([
    ["a target without text", undefined, undefined],
    ["an oversized target and fragment", "<".repeat(1_024), "<".repeat(1_024)],
  ])("answers a reply to %s within the budget, naming what it lacks", async (_, text, quote) => {
    const repository = familyGroup();
    const handler = createTelegramMessageHandler(repository);
    // A long whisper (escaped six times) leaves the target and fragment no room unless they are
    // shortened to fit the timeline's reserve.
    const message = whisper(`/whisper ${"<".repeat(2_000)}`);
    const reply: TelegramMessage = {
      ...message,
      raw: {
        ...message.raw,
        ...(quote === undefined ? {} : { quote: { text: quote } }),
        reply_to_message: {
          chat: { id: "group-101", type: "supergroup" },
          from: { first_name: "Илья", id: 102, is_bot: false, username: "ilya" },
          message_id: 77,
          ...(text === undefined ? { sticker: { file_id: "sticker" } } : { text }),
        },
      },
      replyToMessage: {
        chat: { id: "group-101", title: "Группа", type: "supergroup" as const },
        from: { firstName: "Илья", id: "102", isBot: false, username: "ilya" },
        messageId: "77",
      },
    };

    const result = await handler(telegramContext().context, reply);

    expect(result?.message?.length).toBeLessThanOrEqual(TELEGRAM_GROUP_JOURNAL_CONTEXT_CHARACTERS);
    if (quote !== undefined) {
      expect(result?.message).not.toContain("\\u003c".repeat(1_024 * 2));
    }
    if (text === undefined) expect(result?.message).toContain('"replyTargetUnavailable":true');
    else {
      expect(result?.message).toContain("replyTargetSnapshot");
      expect(result?.message).toContain("replyQuotedText");
    }
  });

  it("gives the whisper memory without consuming the group's skill hint", async () => {
    const repository = familyGroup();
    const handler = createTelegramMessageHandler(repository);

    await handler(telegramContext().context, whisper());

    expect(repository.whisper.memoryContext).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        conversationId: "conversation-group-1",
        query: "о чём они спорят?",
      }),
    );
  });
});
