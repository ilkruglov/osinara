/**
 * Verified Telegram inbound actor classification tests.
 *
 * Constructs covered:
 * - Ordinary human senders remain Telegram user actors.
 * - Channel-authored supergroup posts use raw `sender_chat`, not Telegram's Channel_Bot identity.
 * - Another bot is a visible participant without identity, since Bot API 10.2 delivers its messages.
 * - Ambiguous, malformed, and anonymous-group senders fail closed.
 * - The member tag a supergroup shows next to a sender is read per message and cleaned.
 */
import { describe, expect, it } from "vitest";

import { telegramInboundActor, telegramSenderTag } from "./telegram-inbound-actor.js";
import { groupMessage } from "./telegram-on-message.test-fixtures.js";

describe("telegramInboundActor", () => {
  it("projects an ordinary human sender", () => {
    expect(telegramInboundActor(groupMessage("Привет"))).toEqual({
      actorId: "telegram:telegram-101",
      displayName: "Анна",
      id: "telegram-101",
      kind: "telegram_user",
      timelineKind: "user",
      username: "anna",
    });
  });

  it("projects a verified channel sender instead of Channel_Bot", () => {
    expect(telegramInboundActor({
      ...groupMessage("@osinara_bot вопрос"),
      chat: { id: "-1003576522523", title: "Остриков пилит агентов", type: "supergroup" },
      from: { firstName: "Channel", id: "136817688", isBot: true, username: "Channel_Bot" },
      raw: {
        date: 1_787_000_000,
        from: { first_name: "Channel", id: 136_817_688, is_bot: true, username: "Channel_Bot" },
        sender_chat: {
          id: -1_001_783_384_254,
          title: "Pavel Zloi",
          type: "channel",
          username: "evilfreelancer",
        },
      },
    })).toEqual({
      actorId: "telegram-channel:-1001783384254",
      displayName: "Pavel Zloi",
      id: "-1001783384254",
      kind: "telegram_channel",
      timelineKind: "telegram_channel",
      username: "evilfreelancer",
    });
  });

  it("projects another bot as a participant that carries no identity", () => {
    expect(telegramInboundActor({
      ...groupMessage("сводка погоды"),
      from: { firstName: "Погодный бот", id: "42", isBot: true, username: "weather_bot" },
      raw: {
        date: 1_787_000_000,
        from: { first_name: "Погодный бот", id: 42, is_bot: true, username: "weather_bot" },
      },
    })).toEqual({
      actorId: "telegram-bot:42",
      displayName: "Погодный бот",
      id: "42",
      kind: "telegram_bot",
      timelineKind: "telegram_bot",
      username: "weather_bot",
    });
  });

  it.each([
    {
      label: "anonymous supergroup sender",
      message: {
        ...groupMessage("anonymous"),
        from: { firstName: "Group", id: "1087968824", isBot: true },
        raw: {
          date: 1_787_000_000,
          from: { first_name: "Group", id: 1_087_968_824, is_bot: true },
          sender_chat: { id: -1_003_576_522_523, title: "Group", type: "supergroup" },
        },
      },
    },
    {
      label: "mismatched Channel_Bot identity",
      message: {
        ...groupMessage("mismatch"),
        from: { firstName: "Channel", id: "136817688", isBot: true },
        raw: {
          date: 1_787_000_000,
          from: { first_name: "Channel", id: 999, is_bot: true },
          sender_chat: { id: -1_001_783_384_254, title: "Pavel Zloi", type: "channel" },
        },
      },
    },
    {
      label: "ordinary bot with channel-shaped sender_chat",
      message: {
        ...groupMessage("forged channel shape"),
        from: { firstName: "Bot", id: "42", isBot: true, username: "ordinary_bot" },
        raw: {
          date: 1_787_000_000,
          from: { first_name: "Bot", id: 42, is_bot: true, username: "ordinary_bot" },
          sender_chat: { id: -1_001_783_384_254, title: "Pavel Zloi", type: "channel" },
        },
      },
    },
    {
      label: "human sender with conflicting sender_chat",
      message: {
        ...groupMessage("ambiguous"),
        raw: {
          date: 1_787_000_000,
          sender_chat: { id: -1_001_783_384_254, title: "Pavel Zloi", type: "channel" },
        },
      },
    },
  ])("rejects $label", ({ message }) => {
    expect(telegramInboundActor(message)).toBeNull();
  });
});

// 2 October 2026: supergroup members carry tags such as «Батя» or «Token Burner» in `sender_tag`,
// and Mia did not see them, so «спроси у Бати» meant nothing to her.
describe("telegramSenderTag", () => {
  const withTag = (tag: unknown) => ({ ...groupMessage("Привет"), raw: { ...groupMessage("Привет").raw, sender_tag: tag } });

  it("reads the member tag of the message", () => {
    expect(telegramSenderTag(withTag("Батя"))).toBe("Батя");
  });

  it("flattens control characters and spaces", () => {
    expect(telegramSenderTag(withTag("  ба-да-\nбумс!\u200B "))).toBe("ба-да- бумс!");
  });

  it("returns null without a usable tag", () => {
    expect(telegramSenderTag(groupMessage("Привет"))).toBeNull();
    expect(telegramSenderTag(withTag("   "))).toBeNull();
    expect(telegramSenderTag(withTag(42))).toBeNull();
  });

  it("bounds a long tag", () => {
    expect(telegramSenderTag(withTag("я".repeat(100)))?.length).toBeLessThanOrEqual(64);
  });
});
