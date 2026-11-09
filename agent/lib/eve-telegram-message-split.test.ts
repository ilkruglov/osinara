/**
 * Eve's split of a long text into Telegram messages (vendored `splitTelegramMessageText`), used by
 * final answers, progress notices and the owner digest.
 *
 * Constructs covered:
 * - A cut with no line break or space never splits a surrogate pair: Telegram refuses such a part.
 * - No part is empty: a text whose first line holds only spaces made an empty first part, which
 *   Telegram refuses with 400 (/code-review of the owner digest fix, 9 November 2026).
 */
import { splitTelegramMessageText, TELEGRAM_MESSAGE_TEXT_MAX_LENGTH } from "eve/channels/telegram";
import { describe, expect, it } from "vitest";

describe("splitTelegramMessageText", () => {
  it("keeps a surrogate pair whole where it has to cut inside a word", () => {
    const parts = splitTelegramMessageText(`${"x".repeat(4_095)}😀${"y".repeat(10)}`);

    expect(parts.join("")).toBe(`${"x".repeat(4_095)}😀${"y".repeat(10)}`);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_TEXT_MAX_LENGTH);
      expect(part).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
      );
    }
  });

  it.each([
    ["a first line of spaces", `   \n${"x".repeat(5_000)}`, "x".repeat(5_000)],
    [
      "a tail of spaces after the last cut",
      `${"x".repeat(4_096)}\n${" ".repeat(10)}`,
      "x".repeat(4_096),
    ],
  ])("never gives an empty part, for %s", (_name, text, joined) => {
    const parts = splitTelegramMessageText(text);

    expect(parts.every((part) => part.trim() !== "")).toBe(true);
    expect(parts.join("")).toBe(joined);
  });
});
