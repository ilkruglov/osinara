/**
 * Permanent agent instruction regression tests.
 *
 * Contracts covered:
 * - Conversation style never requires a lowercase first character because MiniMax may drop
 *   the leading token instead of changing its case.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const INSTRUCTIONS_PATH = new URL("../instructions.md", import.meta.url);

describe("permanent agent instructions", () => {
  it("does not require messages to start with a lowercase character", async () => {
    const instructions = await readFile(INSTRUCTIONS_PATH, "utf8");

    expect(instructions).not.toMatch(/начинай сообщение со строчной буквы/iu);
  });
});
