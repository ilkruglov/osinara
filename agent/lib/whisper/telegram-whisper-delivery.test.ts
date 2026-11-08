/**
 * Delivery of a whisper turn: everything goes into the placeholder only its author sees.
 *
 * Constructs covered:
 * - The final answer replaces the placeholder, plain or rich as the chat would show it; authored
 *   asides become one message; the memory directive never shows.
 * - Text written before a tool call stands in the placeholder until the answer replaces it; a turn
 *   that ends with nothing shown tells the author so instead of leaving «Думаю…», also after a
 *   restart, because what the placeholder shows is recorded, not remembered by the process.
 * - An answer longer than one message keeps its first part and says the rest did not fit: a second
 *   ephemeral message is allowed only to a chat administrator.
 * - A reaction becomes the emoji in the placeholder (an ephemeral message cannot be reacted to).
 * - Silence removes the placeholder.
 * - A turn failure is told in the placeholder, but never over an answer already shown.
 * - An edit Telegram did not confirm (5xx, 429, a lost connection) stays recorded for the sweep;
 *   a refusal (4xx) is logged and final; neither is thrown.
 */
import { describe, expect, it, vi } from "vitest";

import { formatTelegramRichMessages } from "../telegram-rich-markdown.js";
import {
  deliverTelegramWhisperCompletion,
  finishTelegramWhisperTurn,
  reportTelegramWhisperFailure,
  telegramWhisperTarget,
  WHISPER_EMPTY_ANSWER_TEXT,
  WHISPER_TRUNCATED_NOTE,
} from "./telegram-whisper-delivery.js";
import {
  memoryPlaceholders,
  PLACEHOLDER_KEY,
  placeholderApi,
} from "./whisper-placeholder.test-fixtures.js";

const AUTH = {
  current: {
    attributes: {
      telegramChatId: "-1001",
      telegramMessageThreadId: "12",
      telegramWhisper: "true",
      telegramWhisperPlaceholderId: "31",
      telegramWhisperReceiverId: "101",
    },
  },
} as never;

function setup(status: "answered" | "failed" | "open" | "progress" = "open") {
  const api = placeholderApi();
  const store = memoryPlaceholders();
  store.seed(status);
  return { api, dependencies: { api, placeholders: store.repository }, store };
}

const edited = (text: string, format: "plain" | "rich" = "plain") => ({
  ...PLACEHOLDER_KEY,
  content: { format, text },
});

describe("telegramWhisperTarget", () => {
  it("reads the placeholder from verified whisper attributes only", () => {
    expect(telegramWhisperTarget(AUTH)).toEqual(PLACEHOLDER_KEY);
    expect(
      telegramWhisperTarget({ current: { attributes: { telegramChatId: "-1001" } } } as never),
    ).toBeNull();
  });
});

describe("deliverTelegramWhisperCompletion", () => {
  it("replaces the placeholder with the plain answer, asides joined and the memory directive cut", async () => {
    const { api, dependencies, store } = setup();

    await deliverTelegramWhisperCompletion(
      {
        finishReason: "stop",
        message: "Прав Илья.\n<telegram-split>\nНо Анна тоже.\n<memory-used>mem_1</memory-used>",
      },
      AUTH,
      dependencies,
    );

    expect(api.edit).toHaveBeenCalledExactlyOnceWith(edited("Прав Илья.\n\nНо Анна тоже."));
    expect(store.row()).toMatchObject({ pendingContent: null, status: "answered" });
  });

  it("keeps rich formatting", async () => {
    const { api, dependencies } = setup();

    await deliverTelegramWhisperCompletion(
      { finishReason: "stop", message: "Итог:\n- раз\n- два" },
      AUTH,
      dependencies,
    );

    expect(api.edit).toHaveBeenCalledExactlyOnceWith(edited("Итог:\n- раз\n- два", "rich"));
  });

  it("puts text written before a tool call into the placeholder until the answer replaces it", async () => {
    const { api, dependencies, store } = setup();

    await deliverTelegramWhisperCompletion(
      { finishReason: "tool-calls", message: "Сейчас посмотрю историю." },
      AUTH,
      dependencies,
    );
    await deliverTelegramWhisperCompletion(
      { finishReason: "stop", message: "<memory-used></memory-used>" },
      AUTH,
      dependencies,
    );
    await finishTelegramWhisperTurn(AUTH, dependencies);

    expect(api.edit).toHaveBeenCalledExactlyOnceWith(edited("Сейчас посмотрю историю."));
    expect(store.row()?.status).toBe("progress");
  });

  it("lets the answer replace the text written before a tool call", async () => {
    const { api, dependencies, store } = setup("progress");

    await deliverTelegramWhisperCompletion(
      { finishReason: "stop", message: "Да." },
      AUTH,
      dependencies,
    );

    expect(api.edit).toHaveBeenCalledExactlyOnceWith(edited("Да."));
    expect(store.row()?.status).toBe("answered");
  });

  it("tells the author when the turn ended with nothing to show, also after a restart", async () => {
    const { api, dependencies, store } = setup();

    await deliverTelegramWhisperCompletion(
      { finishReason: "stop", message: "<memory-used></memory-used>" },
      AUTH,
      dependencies,
    );
    await finishTelegramWhisperTurn(AUTH, dependencies);

    expect(api.edit).toHaveBeenCalledExactlyOnceWith(edited(WHISPER_EMPTY_ANSWER_TEXT));
    expect(store.row()?.status).toBe("failed");
  });

  it.each(["progress", "answered"] as const)(
    "leaves a placeholder that shows %s text alone at the end of the turn",
    async (status) => {
      const { api, dependencies } = setup(status);

      await finishTelegramWhisperTurn(AUTH, dependencies);

      expect(api.edit).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["too many characters", `${"Длинный абзац про спор в чате. ".repeat(100)}\n\n`.repeat(14)],
    [
      "too many blocks",
      Array.from({ length: 700 }, (_, index) => `Пункт ${index + 1}.`).join("\n\n"),
    ],
  ])(
    "keeps whole paragraphs and a note that fit one message when the answer has %s",
    async (_name, message) => {
      const { api, dependencies } = setup();

      await deliverTelegramWhisperCompletion({ finishReason: "stop", message }, AUTH, dependencies);

      expect(api.edit).toHaveBeenCalledOnce();
      const content = (api.edit.mock.calls[0]![0] as { content: { format: string; text: string } })
        .content;
      expect(content.text).toContain(WHISPER_TRUNCATED_NOTE.trim());
      // One valid rich message: a part is never cut inside a block, so no closing tag goes missing.
      expect(formatTelegramRichMessages(content.text)).toHaveLength(1);
      expect(content.text.split("<details>").length).toBe(content.text.split("</details>").length);
    },
  );

  it("puts a reaction into the placeholder as its emoji", async () => {
    const { api, dependencies } = setup();

    await deliverTelegramWhisperCompletion(
      { finishReason: "stop", message: "<telegram-reaction>👍</telegram-reaction>" },
      AUTH,
      dependencies,
    );

    expect(api.edit).toHaveBeenCalledExactlyOnceWith(edited("👍"));
  });

  it("removes the placeholder when the answer is silence", async () => {
    const { api, dependencies, store } = setup();

    await deliverTelegramWhisperCompletion(
      { finishReason: "stop", message: "<telegram-silent>" },
      AUTH,
      dependencies,
    );

    expect(api.delete).toHaveBeenCalledExactlyOnceWith(PLACEHOLDER_KEY);
    expect(api.edit).not.toHaveBeenCalled();
    expect(store.row()).toMatchObject({ pendingContent: null, status: "answered" });
  });

  it("logs a refused edit instead of failing the finished turn, and tries it no more", async () => {
    const { api, dependencies, store } = setup();
    api.edit.mockResolvedValueOnce({
      body: { description: "Bad Request: message to edit not found" },
      ok: false,
      status: 400,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      deliverTelegramWhisperCompletion(
        { finishReason: "stop", message: "Да." },
        AUTH,
        dependencies,
      ),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("AGENT_TELEGRAM_WHISPER_DELIVERY_FAILED"),
    );
    expect(store.row()).toMatchObject({
      lastErrorCode: "TELEGRAM_400",
      pendingContent: null,
      status: "answered",
    });
    warn.mockRestore();
  });

  it.each([
    [
      "a server error",
      () => ({ body: { description: "Internal Server Error" }, ok: false, status: 500 }),
    ],
    [
      "a lost connection",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])(
    "keeps an answer Telegram did not confirm (%s) for the sweep, and the turn end leaves it",
    async (_name, outcome) => {
      const { api, dependencies, store } = setup();
      api.edit.mockImplementationOnce(async () => outcome());
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      await deliverTelegramWhisperCompletion(
        { finishReason: "stop", message: "Да." },
        AUTH,
        dependencies,
      );
      await finishTelegramWhisperTurn(AUTH, dependencies);

      expect(store.row()).toMatchObject({
        attemptCount: 1,
        pendingContent: { format: "plain", text: "Да." },
        status: "answered",
      });
      expect(api.edit).toHaveBeenCalledOnce();
      warn.mockRestore();
    },
  );
});

describe("reportTelegramWhisperFailure", () => {
  it.each(["open", "progress"] as const)(
    "tells the failure in a placeholder that shows %s text",
    async (status) => {
      const { api, dependencies, store } = setup(status);

      await reportTelegramWhisperFailure(
        AUTH,
        "Не получилось ответить. Попробуйте ещё раз",
        dependencies,
      );

      expect(api.edit).toHaveBeenCalledExactlyOnceWith(
        edited("Не получилось ответить. Попробуйте ещё раз"),
      );
      expect(store.row()?.status).toBe("failed");
    },
  );

  it("never overwrites an answer already shown", async () => {
    const { api, dependencies } = setup("answered");

    await reportTelegramWhisperFailure(
      AUTH,
      "Не получилось ответить. Попробуйте ещё раз",
      dependencies,
    );

    expect(api.edit).not.toHaveBeenCalled();
  });
});
