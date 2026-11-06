/**
 * Telegram `/whisper` command recognition, markers and session identity.
 *
 * Constructs covered:
 * - Only an ephemeral `/whisper` from a person in a group or supergroup is a whisper; the bot
 *   suffix must name this bot; the question may be empty (the caller answers with a hint).
 * - Any ephemeral message is recognized as such, so the caller can keep it out of the group queue.
 * - The marker the ingress writes is read back only in its exact shape.
 * - Each (group, topic, person) has its own queue and session token, apart from the group's own.
 * - A whisper session is recognized from verified auth attributes only.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import { describe, expect, it } from "vitest";

import {
  isTelegramEphemeralMessage,
  isTelegramWhisperSession,
  parseTelegramWhisperCommand,
  readTelegramWhisperMarker,
  TELEGRAM_WHISPER_BOT_COMMAND,
  telegramWhisperContinuationToken,
  telegramWhisperQueueKey,
  withTelegramWhisperMarker,
} from "./telegram-whisper.js";

function ephemeral(text: string, overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    attachments: [],
    caption: "",
    chat: { id: "-1001", title: "Группа", type: "supergroup" },
    from: { firstName: "Анна", id: "101", isBot: false, username: "anna" },
    messageId: "0",
    raw: { chat: { id: -1001, type: "supergroup" }, date: 1_700_000_000, ephemeral_message_id: 7, message_id: 0, text },
    text,
    ...overrides,
  };
}

describe("parseTelegramWhisperCommand", () => {
  it.each([
    ["/whisper что они имели в виду?", "что они имели в виду?"],
    ["/whisper@osinara_bot  кто прав?", "кто прав?"],
    ["/WHISPER@Osinara_Bot\nдва\nабзаца", "два\nабзаца"],
    ["/whisper", ""],
    ["/whisper@osinara_bot", ""],
  ])("reads %j as a whisper with the question %j", (text, question) => {
    expect(parseTelegramWhisperCommand(ephemeral(text), "osinara_bot")).toEqual({
      ephemeralMessageId: 7,
      question,
      receiverUserId: "101",
    });
  });

  it.each([
    ["another bot's whisper", ephemeral("/whisper@other_bot привет")],
    ["another command", ephemeral("/ask привет")],
    ["a longer command name", ephemeral("/whisperer привет")],
    ["a public whisper", ephemeral("/whisper привет", { raw: { message_id: 5, text: "/whisper привет" } })],
    ["a private chat", ephemeral("/whisper привет", { chat: { id: "101", type: "private" } })],
    ["a bot sender", ephemeral("/whisper привет", { from: { firstName: "Бот", id: "9", isBot: true } })],
    ["no sender", ephemeral("/whisper привет", { from: undefined })],
    ["a zero ephemeral id", ephemeral("/whisper привет", { raw: { ephemeral_message_id: 0, message_id: 0 } })],
    ["a caption", ephemeral("", { caption: "/whisper привет" })],
  ])("refuses %s", (_name, message) => {
    expect(parseTelegramWhisperCommand(message, "osinara_bot")).toBeNull();
  });
});

describe("isTelegramEphemeralMessage", () => {
  it("recognizes any message that carries an ephemeral id", () => {
    expect(isTelegramEphemeralMessage(ephemeral("/ask привет").raw)).toBe(true);
    expect(isTelegramEphemeralMessage({ message_id: 5, text: "привет" })).toBe(false);
  });
});

describe("whisper markers", () => {
  it("round-trips the placeholder through the stored update payload", () => {
    const payload = { message: { ...ephemeral("/whisper привет").raw }, update_id: 900 };
    const marked = withTelegramWhisperMarker(payload, { ephemeralMessageId: 7, placeholderMessageId: 31, receiverUserId: "101" });

    expect(payload.message).not.toHaveProperty("osinara_whisper");
    expect(readTelegramWhisperMarker((marked.message as Record<string, unknown>))).toEqual({
      ephemeralMessageId: 7,
      placeholderMessageId: 31,
      receiverUserId: "101",
    });
  });

  it.each([
    [{ osinara_whisper: { ephemeralMessageId: 7, placeholderMessageId: 0, receiverUserId: "101" } }],
    [{ osinara_whisper: { ephemeralMessageId: 7, placeholderMessageId: 31, receiverUserId: "" } }],
    [{ osinara_whisper: "31" }],
    [{}],
  ])("reads no marker from %j", (raw) => {
    expect(readTelegramWhisperMarker(raw)).toBeNull();
  });
});

describe("whisper identity", () => {
  it("keeps one queue per chat and person, apart from the chat's own queue", () => {
    expect(telegramWhisperQueueKey("-1001", "101")).toBe("telegram:whisper:-1001:101");
    expect(telegramWhisperQueueKey("-1001", "102")).not.toBe(telegramWhisperQueueKey("-1001", "101"));
  });

  it("keeps one session per group, topic and person", () => {
    expect(telegramWhisperContinuationToken("group-1", null, "101")).toBe("osinara:whisper:group-1:main:101");
    expect(telegramWhisperContinuationToken("group-1", 12, "101")).toBe("osinara:whisper:group-1:topic:12:101");
  });

  it("recognizes a whisper session by its verified attribute only", () => {
    expect(isTelegramWhisperSession({ current: { attributes: { telegramWhisper: "true" } } } as never)).toBe(true);
    expect(isTelegramWhisperSession({ current: { attributes: { telegramWhisper: true } } } as never)).toBe(false);
    expect(isTelegramWhisperSession({ current: null } as never)).toBe(false);
  });

  it("declares an ephemeral command within Telegram's command limits", () => {
    expect(TELEGRAM_WHISPER_BOT_COMMAND.command).toMatch(/^[a-z0-9_]{1,32}$/u);
    expect(TELEGRAM_WHISPER_BOT_COMMAND.description.length).toBeLessThanOrEqual(256);
    expect(TELEGRAM_WHISPER_BOT_COMMAND.is_ephemeral).toBe(true);
  });
});
