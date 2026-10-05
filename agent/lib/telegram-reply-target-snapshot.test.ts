/**
 * Verified Telegram reply-target projection tests.
 *
 * Constructs covered:
 * - `telegramReplyTargetProjection`: extracts the full target and the selected quote from raw input
 *   only for a target whose identity Eve and raw Telegram agree on, in the chat of the message.
 * - The selected quote is bounded and survives a target without text of its own.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import {
  TELEGRAM_REPLY_QUOTE_MAX_CHARACTERS,
  telegramReplyTargetProjection,
} from "./telegram-reply-target-snapshot.js";

function productionReply(): TelegramMessage {
  return {
    attachments: [],
    caption: "",
    chat: { id: "-1003576522523", title: "Дизраптим AZINO чат", type: "supergroup" },
    from: { firstName: "Пух", id: "136817688", isBot: false },
    messageId: "51002",
    raw: {
      date: 1_786_542_434,
      quote: { text: "streisand" },
      reply_to_message: {
        chat: { id: -1_003_576_522_523, title: "Дизраптим AZINO чат", type: "supergroup" },
        date: 1_786_542_306,
        from: { first_name: "Channel", id: 136_817_688, is_bot: true, username: "Channel_Bot" },
        message_id: 51_001,
        sender_chat: { id: -1_001_823_620_813, title: "nlp_daily", type: "channel", username: "nlp_daily" },
        text: "У меня настроен vless, ссылочку кинул в streisand, и орка работает на телефоне",
      },
    },
    replyToMessage: {
      chat: { id: "-1003576522523", title: "Дизраптим AZINO чат", type: "supergroup" },
      from: { firstName: "Channel", id: "136817688", isBot: true, username: "Channel_Bot" },
      messageId: "51001",
    },
    text: "@osinara_bot а чо это",
  };
}

describe("telegramReplyTargetProjection", () => {
  it("extracts the full target, its channel author, and the selected quote separately", () => {
    expect(telegramReplyTargetProjection(productionReply())).toEqual({
      quotedText: "streisand",
      snapshot: {
        contentText: "У меня настроен vless, ссылочку кинул в streisand, и орка работает на телефоне",
        senderDisplayName: "nlp_daily",
        senderUsername: "nlp_daily",
      },
    });
  });

  it("has no quote when the author replied to the whole message", () => {
    const message = productionReply();
    const { quote: _quote, ...raw } = message.raw;

    expect(telegramReplyTargetProjection({ ...message, raw }).quotedText).toBeNull();
  });

  it("keeps the quote of a target that carries no text of its own", () => {
    const message = productionReply();
    const target = message.raw.reply_to_message as Record<string, unknown>;
    const { text: _text, ...textless } = target;

    expect(telegramReplyTargetProjection({
      ...message,
      raw: { ...message.raw, reply_to_message: textless },
    })).toEqual({ quotedText: "streisand", snapshot: null });
  });

  it("bounds a selected quote", () => {
    const message = productionReply();

    const { quotedText } = telegramReplyTargetProjection({
      ...message,
      raw: { ...message.raw, quote: { text: "ж".repeat(TELEGRAM_REPLY_QUOTE_MAX_CHARACTERS + 50) } },
    });

    expect(quotedText).toHaveLength(TELEGRAM_REPLY_QUOTE_MAX_CHARACTERS);
    expect(quotedText?.endsWith("…")).toBe(true);
  });

  it("rejects a raw target that does not match the parsed reply identity", () => {
    const message = productionReply();
    const raw = message.raw.reply_to_message as Record<string, unknown>;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(telegramReplyTargetProjection({
      ...message,
      raw: { ...message.raw, reply_to_message: { ...raw, message_id: 51_000 } },
    })).toEqual({ quotedText: null, snapshot: null });
    expect(error.mock.calls[0]?.[0]).toContain("AGENT_TELEGRAM_REPLY_TARGET_REJECTED");
    error.mockRestore();
  });

  it("rejects a target that belongs to another chat", () => {
    const message = productionReply();
    const raw = message.raw.reply_to_message as Record<string, unknown>;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(telegramReplyTargetProjection({
      ...message,
      raw: { ...message.raw, reply_to_message: { ...raw, chat: { id: -1_009, type: "supergroup" } } },
      replyToMessage: {
        ...message.replyToMessage!,
        chat: { id: "-1009", type: "supergroup" },
      },
    })).toEqual({ quotedText: null, snapshot: null });
    expect(error.mock.calls[0]?.[0]).toContain("foreign_chat");
    error.mockRestore();
  });

  it("ignores a quote without a reply target in this chat", () => {
    const message = productionReply();
    const { reply_to_message: _target, ...raw } = message.raw;

    expect(telegramReplyTargetProjection({
      ...message,
      raw,
      replyToMessage: undefined,
    })).toEqual({ quotedText: null, snapshot: null });
  });
});
