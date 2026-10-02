/**
 * Display text contract tests.
 *
 * Constructs covered:
 * - Flattening removes control and format characters and collapses whitespace.
 * - Clipping fits the limit, marks the cut and never splits a surrogate pair.
 */
import { describe, expect, it } from "vitest";

import { clipText, flattenDisplayText } from "./display-text.js";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

describe("display text", () => {
  it("flattens a model-written value to one clean line", () => {
    expect(flattenDisplayText(" а\n\nб​\tв\u0007 ")).toBe("а б в");
  });

  it("keeps text that fits and marks a cut", () => {
    expect(clipText("короткий", 100)).toBe("короткий");
    expect(clipText("длинная строка", 8)).toBe("длинная…");
  });

  it("never splits a surrogate pair", () => {
    const emoji = "🙂".repeat(50);
    for (let limit = 2; limit <= emoji.length; limit += 1) {
      const clipped = clipText(emoji, limit);
      expect(clipped.length).toBeLessThanOrEqual(limit);
      expect(LONE_SURROGATE.test(clipped)).toBe(false);
    }
  });
});
