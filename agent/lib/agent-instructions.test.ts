/**
 * Permanent agent instruction regression tests.
 *
 * Contracts covered:
 * - Conversation style never requires a lowercase first character because MiniMax may drop
 *   the leading token instead of changing its case.
 *
 * Key constructs:
 * - `LOWERCASE_MESSAGE_START_INSTRUCTION`: detects equivalent Russian phrasings of that rule.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const INSTRUCTIONS_PATH = new URL("../instructions.md", import.meta.url);
const LOWERCASE_MESSAGE_START_INSTRUCTION = new RegExp(
  [
    String.raw`(?:начин\p{L}*|перв\p{L}*\s+(?:букв\p{L}*|символ\p{L}*))`,
    String.raw`.{0,100}(?:строчн\p{L}*|маленьк\p{L}*)`,
    String.raw`|(?:строчн\p{L}*|маленьк\p{L}*).{0,100}`,
    String.raw`(?:начин\p{L}*|перв\p{L}*\s+(?:букв\p{L}*|символ\p{L}*))`,
  ].join(""),
  "iu",
);

describe("permanent agent instructions", () => {
  it.each([
    "Начинай сообщение со строчной буквы",
    "Первая буква сообщения должна быть маленькой",
    "Со строчной буквы всегда начинай обычный ответ",
  ])("recognizes a prohibited lowercase-start rule: %s", (instruction) => {
    expect(instruction).toMatch(LOWERCASE_MESSAGE_START_INSTRUCTION);
  });

  it("does not require messages to start with a lowercase character", async () => {
    const instructions = await readFile(INSTRUCTIONS_PATH, "utf8");

    expect(instructions).not.toMatch(LOWERCASE_MESSAGE_START_INSTRUCTION);
  });
});
