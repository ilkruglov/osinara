/**
 * Verified Telegram reply-target projection tests.
 *
 * Constructs covered:
 * - `telegramReplyTargetProjection`: extracts the full target and the selected quote from raw input
 *   only for a target whose identity Eve and raw Telegram agree on, in the chat of the message.
 * - The selected quote is bounded and survives a target without text of its own.
 * - The full target follows the journal's rule: a target that tells a secret in words gives neither
 *   a snapshot nor a quote; a key is masked before a long target is cut.
 * - The quote is masked on its own and where it overlaps a key of the full target.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import {
  TELEGRAM_REPLY_QUOTE_MAX_CHARACTERS,
  TELEGRAM_REPLY_SNAPSHOT_MAX_CHARACTERS,
  telegramReplyTargetProjection,
} from "./telegram-reply-target-snapshot.js";

function productionReply(
  targetText = "У меня настроен vless, ссылочку кинул в streisand, и орка работает на телефоне",
): TelegramMessage {
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
        sender_chat: {
          id: -1_001_823_620_813,
          title: "nlp_daily",
          type: "channel",
          username: "nlp_daily",
        },
        text: targetText,
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
        contentText:
          "У меня настроен vless, ссылочку кинул в streisand, и орка работает на телефоне",
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

    expect(
      telegramReplyTargetProjection({
        ...message,
        raw: { ...message.raw, reply_to_message: textless },
      }),
    ).toEqual({ quotedText: "streisand", snapshot: null });
  });

  it("reads the text of a rich target from its blocks when text and caption are empty", () => {
    const message = productionReply();
    const target = message.raw.reply_to_message as Record<string, unknown>;
    const { text: _text, ...textless } = target;
    const rich = {
      ...textless,
      rich_message: {
        blocks: [
          { photo: [{ file_id: "p" }], type: "photo" },
          { text: "пост про эвалы", type: "paragraph" },
        ],
      },
    };

    const projection = telegramReplyTargetProjection({
      ...message,
      raw: { ...message.raw, reply_to_message: rich },
    });
    expect(projection.snapshot?.contentText).toBe("пост про эвалы");
  });

  // Repeat review, 23 November 2026: Telegram joins a rich message's blocks with one line break, the
  // projection with two, so a quote across a masked key was not found and came through open; and a
  // quote chosen from a rich message may come only as `rich_texts`.
  describe("a quote of a rich target", () => {
    const richReply = (quote: Record<string, unknown>) => {
      const message = productionReply();
      const target = message.raw.reply_to_message as Record<string, unknown>;
      const { text: _text, ...textless } = target;
      return {
        ...message,
        raw: {
          ...message.raw,
          quote,
          reply_to_message: {
            ...textless,
            rich_message: {
              blocks: [
                { text: "FAL_KEY=abcdefghij0123456789", type: "paragraph" },
                { text: "отозван", type: "paragraph" },
              ],
            },
          },
        },
      };
    };

    it("is matched against the blocks joined by one line feed and masked where it is a key", () => {
      const projection = telegramReplyTargetProjection(
        richReply({ text: "ij0123456789\nотозван" }),
      );

      expect(projection.quotedText).toBe("[СКРЫТО]\nотозван");
      expect(projection.snapshot?.contentText).toBe("FAL_KEY=[СКРЫТО]\n\nотозван");
    });

    it("masks a key quoted from a code block of the target", () => {
      const message = productionReply();
      const target = message.raw.reply_to_message as Record<string, unknown>;
      const { text: _text, ...textless } = target;
      const projection = telegramReplyTargetProjection({
        ...message,
        raw: {
          ...message.raw,
          quote: { rich_texts: ["abcdefghij0123456789"], text: "" },
          reply_to_message: {
            ...textless,
            rich_message: {
              blocks: [
                { text: "Ключ:", type: "paragraph" },
                { text: "FAL_KEY=abcdefghij0123456789", type: "pre" },
              ],
            },
          },
        },
      });

      expect(projection.quotedText).toBe("[СКРЫТО]");
    });

    // Repeat review, 23 November 2026: a key split across parts of a rich text, a password in a
    // block the projection skips, a quote of two table cells.
    const withBlocks = (blocks: unknown[], quote: Record<string, unknown>) => {
      const message = productionReply();
      const target = message.raw.reply_to_message as Record<string, unknown>;
      const { text: _text, ...textless } = target;
      return telegramReplyTargetProjection({
        ...message,
        raw: { ...message.raw, quote, reply_to_message: { ...textless, rich_message: { blocks } } },
      });
    };

    it("masks a key split across the parts of a map's caption", () => {
      const projection = withBlocks(
        [
          { text: "План", type: "paragraph" },
          {
            caption: { text: ["FAL_KEY=", { text: "abcdefghij0123456789", type: "bold" }] },
            type: "map",
          },
        ],
        { rich_texts: [{ text: "abcdefghij0123456789", type: "bold" }], text: "" },
      );

      expect(projection.quotedText).toBe("[СКРЫТО]");
    });

    it("finds a quote of two table cells in a message with a key elsewhere", () => {
      const projection = withBlocks(
        [
          { text: "FAL_KEY=abcdefghij0123456789", type: "pre" },
          { cells: [[{ text: "Север" }, { text: "Юг" }]], type: "table" },
        ],
        { rich_texts: ["Север", "Юг"], text: "" },
      );

      expect(projection.quotedText).toBe("Север\nЮг");
    });

    // Narrow final review, 23 November 2026: the journal's form joined a row's cells with « | », and
    // the spoken rule missed a password in a table; the cells are split by a tab now.
    it.each([
      ["plain", { text: "Qwerty12345" }],
      ["bold", { text: { text: "Qwerty12345", type: "bold" } }],
    ])("gives nothing of a table that tells a password in a %s cell", (_kind, value) => {
      const projection = withBlocks([{ cells: [[{ text: "Пароль:" }, value]], type: "table" }], {
        rich_texts: ["Qwerty12345"],
        text: "",
      });

      expect(projection).toEqual({ quotedText: null, snapshot: null });
    });

    // A block's type name read as the word after «пароль:» dropped a harmless quote; so did an
    // emoji's id read as a card (owner, «Проверять только видимый текст»).
    it("keeps a quote of the paragraph after one that asks for a password", () => {
      const projection = withBlocks(
        [
          { text: "Нужен пароль:", type: "paragraph" },
          { text: "Нет", type: "paragraph" },
        ],
        { text: "Нет" },
      );

      expect(projection.quotedText).toBe("Нет");
    });

    it("keeps a quote of a message with a custom emoji whose id reads as a card", () => {
      const projection = withBlocks(
        [
          {
            text: [
              "Встреча в пятницу в 19:00 ",
              { custom_emoji_id: "5270501411291171129", text: "🔥", type: "custom_emoji" },
            ],
            type: "paragraph",
          },
        ],
        { text: "в пятницу" },
      );

      expect(projection.quotedText).toBe("в пятницу");
    });

    it("is dropped when it cannot be found in a target with a key", () => {
      const projection = telegramReplyTargetProjection(
        richReply({ text: "ij0123456789 и отозван" }),
      );

      expect(projection.quotedText).toBeNull();
    });

    it("is read from rich_texts when its text is empty", () => {
      const projection = telegramReplyTargetProjection(
        richReply({ rich_texts: [["отоз", { text: "ван", type: "bold" }]], text: "" }),
      );

      expect(projection.quotedText).toBe("отозван");
    });
  });

  it("bounds a selected quote", () => {
    const message = productionReply();

    const { quotedText } = telegramReplyTargetProjection({
      ...message,
      raw: {
        ...message.raw,
        quote: { text: "ж".repeat(TELEGRAM_REPLY_QUOTE_MAX_CHARACTERS + 50) },
      },
    });

    expect(quotedText).toHaveLength(TELEGRAM_REPLY_QUOTE_MAX_CHARACTERS);
    expect(quotedText?.endsWith("…")).toBe(true);
  });

  it("rejects a raw target that does not match the parsed reply identity", () => {
    const message = productionReply();
    const raw = message.raw.reply_to_message as Record<string, unknown>;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(
      telegramReplyTargetProjection({
        ...message,
        raw: { ...message.raw, reply_to_message: { ...raw, message_id: 51_000 } },
      }),
    ).toEqual({ quotedText: null, snapshot: null });
    expect(error.mock.calls[0]?.[0]).toContain("AGENT_TELEGRAM_REPLY_TARGET_REJECTED");
    error.mockRestore();
  });

  it("rejects a target that belongs to another chat", () => {
    const message = productionReply();
    const raw = message.raw.reply_to_message as Record<string, unknown>;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(
      telegramReplyTargetProjection({
        ...message,
        raw: {
          ...message.raw,
          reply_to_message: { ...raw, chat: { id: -1_009, type: "supergroup" } },
        },
        replyToMessage: {
          ...message.replyToMessage!,
          chat: { id: "-1009", type: "supergroup" },
        },
      }),
    ).toEqual({ quotedText: null, snapshot: null });
    expect(error.mock.calls[0]?.[0]).toContain("foreign_chat");
    error.mockRestore();
  });

  it("ignores a quote without a reply target in this chat", () => {
    const message = productionReply();
    const { reply_to_message: _target, ...raw } = message.raw;

    expect(
      telegramReplyTargetProjection({
        ...message,
        raw,
        replyToMessage: undefined,
      }),
    ).toEqual({ quotedText: null, snapshot: null });
  });

  // The journal keeps no text of such a message; Telegram's copy must not bring it back.
  it("gives neither a snapshot nor a quote of a target that tells a password", () => {
    expect(
      telegramReplyTargetProjection(productionReply("Вайфай на даче, пароль: Qwerty-12345")),
    ).toEqual({ quotedText: null, snapshot: null });
  });

  it("masks a key of the target and keeps the rest of its text", () => {
    const reply = productionReply("Ключ сервера: FAL_KEY=abcdefghij0123456789");
    expect(
      telegramReplyTargetProjection({
        ...reply,
        raw: { ...reply.raw, quote: { text: "сервера" } },
      }),
    ).toMatchObject({
      quotedText: "сервера",
      snapshot: { contentText: "Ключ сервера: FAL_KEY=[СКРЫТО]" },
    });
  });

  it("masks a key before the long target is cut", () => {
    const reply = productionReply(`${"x".repeat(1_010)} ключ sk-abcdefgh12345`);

    const snapshot = telegramReplyTargetProjection(reply).snapshot;
    expect(snapshot?.contentText.length).toBeLessThanOrEqual(
      TELEGRAM_REPLY_SNAPSHOT_MAX_CHARACTERS,
    );
    expect(snapshot?.contentText).not.toContain("abcd");
  });

  it.each([
    ["FAL_KEY=abcdefghij0123456789", "Сервер: FAL_KEY=abcdefghij0123456789", "FAL_KEY=[СКРЫТО]"],
    ["abcdefghij0123456789", "FAL_KEY=abcdefghij0123456789", "[СКРЫТО]"],
    ["abcd", "FAL_KEY=abcdefghij0123456789", "[СКРЫТО]"],
    [
      "сервера, FAL_KEY=abcd",
      "Ключ сервера, FAL_KEY=abcdefghij0123456789",
      "сервера, FAL_KEY=[СКРЫТО]",
    ],
    ["Ключ", "Ключ сервера, FAL_KEY=abcdefghij0123456789", "Ключ"],
  ])("masks the quote %j of %j", (quote, text, masked) => {
    const reply = productionReply(text);

    const projection = telegramReplyTargetProjection({
      ...reply,
      raw: { ...reply.raw, quote: { text: quote } },
    });
    expect(projection.quotedText).toBe(masked);
  });

  it("gives no quote that tells a password itself", () => {
    const reply = productionReply("");

    const projection = telegramReplyTargetProjection({
      ...reply,
      raw: { ...reply.raw, quote: { text: "пароль Qwerty123" } },
    });
    expect(projection).toEqual({ quotedText: null, snapshot: null });
  });

  it("cuts a long target to the snapshot bound", () => {
    const reply = productionReply("<".repeat(5_000));

    const snapshot = telegramReplyTargetProjection(reply).snapshot;
    expect(snapshot?.contentText.length).toBeLessThanOrEqual(
      TELEGRAM_REPLY_SNAPSHOT_MAX_CHARACTERS,
    );
    expect(snapshot?.contentText.startsWith("<<<")).toBe(true);
  });
});
