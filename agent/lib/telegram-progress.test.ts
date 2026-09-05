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
  it("delivers model-authored pre-tool text as an interim progress notice", () => {
    expect(
      completedTelegramOutput({
        finishReason: "tool-calls",
        message: "Собрал информацию. Теперь формирую документ.",
      }),
    ).toEqual({ kind: "progress", message: "Собрал информацию. Теперь формирую документ." });
  });

  it("drops interim text that carries a reaction directive", () => {
    expect(
      completedTelegramOutput({
        finishReason: "tool-calls",
        message: "<telegram-reaction>👍</telegram-reaction>",
      }),
    ).toBeNull();
  });

  it("does not deliver an answer made of transport directives alone", () => {
    expect(completedTelegramOutput({ finishReason: "stop", message: "<telegram-split>" }))
      .toBeNull();
  });

  it("separates the memory-used directive from the delivered final answer", () => {
    expect(completedTelegramOutput({
      finishReason: "stop",
      message: "Гоша дома.\n<memory-used>mem_0123456789abcdef0123456789abcdef</memory-used>",
    })).toEqual({
      kind: "message",
      memoryUsedRefs: ["mem_0123456789abcdef0123456789abcdef"],
      message: "Гоша дома.",
    });
    expect(completedTelegramOutput({
      finishReason: "stop",
      message: "<memory-used>mem_0123456789abcdef0123456789abcdef</memory-used>",
    })).toBeNull();
  });

  it("keeps aside directives inside a final answer for the presentation layer", () => {
    expect(
      completedTelegramOutput({ finishReason: "stop", message: "Готово\n<telegram-split>\nкстати" }),
    ).toEqual({ kind: "message", memoryUsedRefs: [], message: "Готово\n<telegram-split>\nкстати" });
  });

  it("trims surrounding whitespace from a delivered message", () => {
    expect(
      completedTelegramOutput({ finishReason: "stop", message: "\n\nГотовый ответ  " }),
    ).toEqual({ kind: "message", memoryUsedRefs: [], message: "Готовый ответ" });
  });

  it.each(["👍", "❤", "❤️", "🔥", "🥰", "🤔", "🤯", "🫡", "👀", "🖕", "1️⃣", "🇺🇸"])(
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
    "<telegram-reaction>🇦</telegram-reaction>",
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
