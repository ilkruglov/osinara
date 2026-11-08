/**
 * Failure notice tests.
 *
 * Constructs covered:
 * - The person reads the failure sentence without its stable code prefix, or a plain fallback.
 * - A group message never produces a notice; a whisper is told in its own placeholder, but never
 *   over an answer it already shows.
 */
import { describe, expect, it, vi } from "vitest";

import { failureNoticeText, sendTelegramFailureNotice } from "./telegram-failure-notice.js";
import { memoryPlaceholders, placeholderApi } from "./whisper/whisper-placeholder.test-fixtures.js";

describe("telegram failure notice", () => {
  it("shows the person-facing sentence only", () => {
    expect(
      failureNoticeText({
        code: "AGENT_TELEGRAM_INGRESS_FAILED",
        message: "AGENT_TELEGRAM_INGRESS_FAILED: Не удалось обработать сообщение Telegram",
      }),
    ).toBe("Не удалось обработать сообщение Telegram");
    expect(
      failureNoticeText({
        code: "AGENT_VOICE_FILE_TOO_LARGE",
        message: "Отправьте более короткую запись",
      }),
    ).toBe("Отправьте более короткую запись");
    expect(failureNoticeText({ code: "X", message: "AGENT_X: " })).toBe(
      "Не удалось обработать это сообщение. Отправьте его ещё раз",
    );
  });

  it("stays silent outside a private chat", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await sendTelegramFailureNotice(
      {
        kind: "message",
        message: {
          attachments: [],
          caption: "",
          chat: { id: "-100", type: "group" },
          messageId: "7",
          raw: {},
          text: "привет",
        },
      } as never,
      { code: "AGENT_TELEGRAM_INGRESS_FAILED", message: "Не удалось" },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("tells a failed whisper in its placeholder, which only its author sees, but never over its answer", async () => {
    const api = placeholderApi();
    const store = memoryPlaceholders();
    store.seed("open", { chatId: "-100", placeholderMessageId: 31, receiverUserId: "101" });
    const update = {
      kind: "message",
      message: {
        attachments: [],
        caption: "",
        chat: { id: "-100", type: "supergroup" },
        messageId: "0",
        raw: {
          ephemeral_message_id: 7,
          osinara_whisper: {
            ephemeralMessageId: 7,
            placeholderMessageId: 31,
            receiverUserId: "101",
          },
        },
        text: "/whisper привет",
      },
    } as never;
    const failure = {
      code: "AGENT_TELEGRAM_INGRESS_FAILED",
      message: "AGENT_TELEGRAM_INGRESS_FAILED: Не удалось обработать сообщение Telegram",
    };

    await sendTelegramFailureNotice(update, failure, { api, placeholders: store.repository });
    expect(api.edit).toHaveBeenCalledExactlyOnceWith({
      chatId: "-100",
      content: { format: "plain", text: "Не удалось обработать сообщение Telegram" },
      placeholderMessageId: 31,
      receiverUserId: "101",
    });

    // After a restart the drain may refuse the update of a whisper that was already answered.
    store.seed("answered", { chatId: "-100", placeholderMessageId: 31, receiverUserId: "101" });
    await sendTelegramFailureNotice(update, failure, { api, placeholders: store.repository });
    expect(api.edit).toHaveBeenCalledOnce();
  });
});
