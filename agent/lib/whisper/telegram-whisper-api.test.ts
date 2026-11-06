/**
 * Bot API calls of a whisper: the placeholder reply, its edit into the answer, its removal.
 *
 * Constructs covered:
 * - The placeholder replies to the ephemeral command for its author only, in the command's topic,
 *   and its own ephemeral id comes back for the later edit.
 * - The answer replaces the placeholder as rich or plain text; an unchanged text is not a failure.
 * - Telegram's refusal is returned to the caller, never thrown.
 */
import { describe, expect, it, vi } from "vitest";

import {
  deleteTelegramWhisperMessage,
  editTelegramWhisperMessage,
  sendTelegramWhisperReply,
} from "./telegram-whisper-api.js";

function telegram(body: unknown, status = 200) {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status }));
}

function sentBody(fetch: ReturnType<typeof telegram>, call = 0): Record<string, unknown> {
  const init = fetch.mock.calls[call]![1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function sentMethod(fetch: ReturnType<typeof telegram>, call = 0): string {
  return String(fetch.mock.calls[call]![0]).split("/").at(-1)!;
}

describe("whisper Bot API", () => {
  it("replies to the ephemeral command for its author only and returns the reply's ephemeral id", async () => {
    const fetch = telegram({ ok: true, result: { chat: { id: -1001 }, ephemeral_message_id: 31, message_id: 0 } });

    await expect(sendTelegramWhisperReply({
      botToken: "token", chatId: "-1001", ephemeralMessageId: 7, fetch, messageThreadId: 12, receiverUserId: "101", text: "Думаю…",
    })).resolves.toEqual({ ok: true, placeholderMessageId: 31 });

    expect(sentMethod(fetch)).toBe("sendMessage");
    expect(sentBody(fetch)).toEqual({
      chat_id: -1001,
      ephemeral_message_parameters: { receiver_user_id: 101 },
      message_thread_id: 12,
      reply_parameters: { ephemeral_message_id: 7 },
      text: "Думаю…",
    });
  });

  it("returns Telegram's refusal of a late reply instead of throwing", async () => {
    const fetch = telegram({ description: "Bad Request: message to be replied not found", error_code: 400, ok: false }, 400);

    await expect(sendTelegramWhisperReply({
      botToken: "token", chatId: "-1001", ephemeralMessageId: 7, fetch, messageThreadId: null, receiverUserId: "101", text: "Думаю…",
    })).resolves.toEqual({ body: expect.objectContaining({ error_code: 400 }), ok: false, status: 400 });
  });

  it("edits the placeholder into a rich answer", async () => {
    const fetch = telegram({ ok: true, result: true });

    await expect(editTelegramWhisperMessage({
      botToken: "token", chatId: "-1001", content: { format: "rich", text: "**Да**, прав Илья." }, fetch, placeholderMessageId: 31, receiverUserId: "101",
    })).resolves.toEqual({ ok: true });

    expect(sentMethod(fetch)).toBe("editEphemeralMessageText");
    expect(sentBody(fetch)).toEqual({
      chat_id: -1001,
      ephemeral_message_id: 31,
      receiver_user_id: 101,
      rich_message: { markdown: "**Да**, прав Илья." },
    });
  });

  it("edits the placeholder into plain text and accepts an unchanged text", async () => {
    const fetch = telegram({ description: "Bad Request: message is not modified", error_code: 400, ok: false }, 400);

    await expect(editTelegramWhisperMessage({
      botToken: "token", chatId: "-1001", content: { format: "plain", text: "Да." }, fetch, placeholderMessageId: 31, receiverUserId: "101",
    })).resolves.toEqual({ ok: true });

    expect(sentBody(fetch)).toEqual({ chat_id: -1001, ephemeral_message_id: 31, receiver_user_id: 101, text: "Да." });
  });

  it("removes the placeholder", async () => {
    const fetch = telegram({ ok: true, result: true });

    await expect(deleteTelegramWhisperMessage({
      botToken: "token", chatId: "-1001", fetch, placeholderMessageId: 31, receiverUserId: "101",
    })).resolves.toEqual({ ok: true });

    expect(sentMethod(fetch)).toBe("deleteEphemeralMessage");
    expect(sentBody(fetch)).toEqual({ chat_id: -1001, ephemeral_message_id: 31, receiver_user_id: 101 });
  });
});
