/**
 * Telegram model-message delivery policy tests.
 *
 * Constructs covered:
 * - `completedTelegramOutput`: separates visible text from terminal reaction directives.
 * - Pre-tool assistant chunks remain hidden because Telegram cannot render them ephemerally.
 * - Empty model steps remain invisible to avoid technical Telegram noise.
 */
import { describe, expect, it } from "vitest";

import { completedTelegramOutput } from "./telegram-progress.js";

describe("completedTelegramOutput", () => {
  it("does not deliver model-authored pre-tool text as a separate Telegram message", () => {
    expect(
      completedTelegramOutput({
        finishReason: "tool-calls",
        message: "Собрал информацию. Теперь формирую документ.",
      }),
    ).toBeNull();
  });

  it("trims surrounding whitespace from a delivered message", () => {
    expect(
      completedTelegramOutput({ finishReason: "stop", message: "\n\nГотовый ответ  " }),
    ).toEqual({ kind: "message", message: "Готовый ответ" });
  });

  it.each(["👍", "❤", "❤️", "🔥", "🥰", "🤔", "🤯", "🫡", "👀", "🖕"])(
    "parses one %s emoji reaction without visible text",
    (emoji) => {
      expect(
        completedTelegramOutput({
          finishReason: "stop",
          message: `\n<telegram-reaction>${emoji}</telegram-reaction>\n`,
        }),
      ).toEqual({ emoji, kind: "reaction" });
    },
  );

  it.each([
    "<telegram-reaction>не emoji</telegram-reaction>",
    "<telegram-reaction>🔥🔥</telegram-reaction>",
    "Хорошо <telegram-reaction>👌</telegram-reaction>",
    "<telegram-reaction>👍</telegram-reaction> Молчу",
    "<telegram-reaction></telegram-reaction>",
  ])("rejects malformed or mixed reaction output: %s", (message) => {
    expect(() => completedTelegramOutput({ finishReason: "stop", message }))
      .toThrowError(/AGENT_TELEGRAM_REACTION_DIRECTIVE_INVALID/u);
  });

  it.each([
    { finishReason: "tool-calls", message: "   " },
    { finishReason: "stop", message: "" },
    { finishReason: "stop", message: null },
    { finishReason: "stop" },
  ])("does not expose an empty technical step %#", (data) => {
    expect(completedTelegramOutput(data)).toBeNull();
  });
});
