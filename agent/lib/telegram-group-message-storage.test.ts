/**
 * Telegram group message storage semantic tests.
 *
 * Constructs covered:
 * - `telegramForumTopicId`: distinguishes real forum topics from ordinary reply threads.
 * - Durable timeline content: a secret told in words keeps no text of the message, its caption
 *   included; a machine form is masked and the rest of the text stays.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import { describe, expect, it } from "vitest";

import { telegramForumTopicId, telegramMessageContent } from "./telegram-group-message-storage.js";

function message(input: { isTopicMessage?: boolean; threadId?: number }): TelegramMessage {
  return {
    attachments: [],
    caption: "",
    chat: { id: "-1001", title: "Группа", type: "supergroup" },
    from: { firstName: "Анна", id: "101", isBot: false },
    messageId: "10",
    ...(input.threadId === undefined ? {} : { messageThreadId: input.threadId }),
    raw: {
      date: 1_700_000_000,
      ...(input.isTopicMessage === undefined ? {} : { is_topic_message: input.isTopicMessage }),
    },
    text: "сообщение",
  };
}

describe("telegramForumTopicId", () => {
  it("keeps no text of a message that tells a password", () => {
    expect(
      telegramMessageContent({
        ...message({}),
        caption: "это от роутера",
        text: "Пароль: correct-horse-battery-staple",
      }),
    ).toBeNull();
  });

  it("masks a key in durable timeline content and keeps the rest", () => {
    expect(
      telegramMessageContent({
        ...message({}),
        caption: "это от сервера",
        text: "ключ FAL_KEY=abcdefghij0123456789",
      }),
    ).toBe("ключ FAL_KEY=[СКРЫТО]\nэто от сервера");
  });

  it("ignores a delivery thread on an ordinary supergroup reply", () => {
    expect(telegramForumTopicId(message({ threadId: 310 }))).toBeNull();
  });

  it("returns the verified topic ID for a forum message", () => {
    expect(telegramForumTopicId(message({ isTopicMessage: true, threadId: 42 }))).toBe("42");
  });

  it("fails when Telegram marks a forum message without a topic ID", () => {
    expect(() => telegramForumTopicId(message({ isTopicMessage: true }))).toThrow(
      "AGENT_TELEGRAM_MESSAGE_INVALID",
    );
  });
});

describe("telegramMessageContent", () => {
  it("marks a forward as someone else's words, a captionless one too", () => {
    const forwarded = {
      ...message({}),
      raw: {
        date: 1_700_000_000,
        forward_origin: { sender_user_name: "Аноним", type: "hidden_user" },
      },
    };
    expect(telegramMessageContent({ ...forwarded, text: "встреча в пять" })).toBe(
      "[переслано от Аноним]\nвстреча в пять",
    );
    expect(telegramMessageContent({ ...forwarded, text: "" })).toBe("[переслано от Аноним]");
    expect(telegramMessageContent(message({}))).toBe("сообщение");
  });
});
