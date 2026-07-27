/**
 * Telegram model-message delivery policy tests.
 *
 * Constructs covered:
 * - `completedTelegramMessage`: delivers only terminal user-visible assistant text.
 * - Pre-tool assistant chunks remain hidden because Telegram cannot render them ephemerally.
 * - Empty model steps remain invisible to avoid technical Telegram noise.
 */
import { describe, expect, it } from "vitest";

import { completedTelegramMessage } from "./telegram-progress.js";

describe("completedTelegramMessage", () => {
  it("does not deliver model-authored pre-tool text as a separate Telegram message", () => {
    expect(
      completedTelegramMessage({
        finishReason: "tool-calls",
        message: "Собрал информацию. Теперь формирую документ.",
      }),
    ).toBeNull();
  });

  it("trims surrounding whitespace from a delivered message", () => {
    expect(
      completedTelegramMessage({ finishReason: "stop", message: "\n\nГотовый ответ  " }),
    ).toBe("Готовый ответ");
  });

  it.each([
    { finishReason: "tool-calls", message: "   " },
    { finishReason: "stop", message: "" },
    { finishReason: "stop", message: null },
    { finishReason: "stop" },
  ])("does not expose an empty technical step %#", (data) => {
    expect(completedTelegramMessage(data)).toBeNull();
  });
});
