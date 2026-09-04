/**
 * Verified Telegram inbound actor classification tests.
 *
 * Constructs covered:
 * - Ordinary human senders remain Telegram user actors.
 * - Channel-authored supergroup posts use raw `sender_chat`, not Telegram's Channel_Bot identity.
 * - Ordinary bots become explicit bot actors once Telegram delivers their group messages.
 * - Ambiguous, malformed, and anonymous-group senders fail closed.
 */
import { describe, expect, it } from "vitest";

import { telegramInboundActor } from "./telegram-inbound-actor.js";
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

  it("projects an ordinary bot sender", () => {
    expect(telegramInboundActor({
      ...groupMessage("Осинара, привет"),
      from: { firstName: "Мия", id: "8123456789", isBot: true, username: "mimimia_ai_bot" },
      raw: {
        date: 1_787_000_000,
        from: { first_name: "Мия", id: 8_123_456_789, is_bot: true, username: "mimimia_ai_bot" },
      },
    })).toEqual({
      actorId: "telegram-bot:8123456789",
      displayName: "Мия",
      id: "8123456789",
      kind: "telegram_bot",
      timelineKind: "telegram_bot",
      username: "mimimia_ai_bot",
    });
  });

  it.each([
    {
      label: "a bot whose raw sender contradicts the parsed identity",
      raw: { date: 1_787_000_000, from: { first_name: "Мия", id: 999, is_bot: true } },
    },
    {
      label: "a bot whose raw sender is not marked as a bot",
      raw: { date: 1_787_000_000, from: { first_name: "Мия", id: 42, is_bot: false } },
    },
    {
      label: "a bot without a raw sender",
      raw: { date: 1_787_000_000 },
    },
  ])("rejects $label", ({ raw }) => {
    expect(telegramInboundActor({
      ...groupMessage("подделка"),
      from: { firstName: "Мия", id: "42", isBot: true },
      raw,
    })).toBeNull();
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
