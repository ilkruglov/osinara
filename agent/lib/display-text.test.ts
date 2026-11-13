/**
 * Display text contract tests.
 *
 * Constructs covered:
 * - Flattening removes control and format characters and collapses whitespace.
 * - Clipping fits the limit, marks the cut and never splits a surrogate pair.
 * - `sliceText` cuts without a mark; `clipMiddleText` keeps the head and the tail around a count of
 *   what was left out, never exceeds the limit (even below the size of that count) and never
 *   splits a pair at either cut.
 */
import { describe, expect, it } from "vitest";

import { clipMiddleText, clipText, flattenDisplayText, sliceText } from "./display-text.js";

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

  it("slices without a mark and without splitting a pair", () => {
    expect(sliceText("абвгд", 3)).toBe("абв");
    expect(sliceText("a😀b", 2)).toBe("a");
    expect(sliceText("short", 10)).toBe("short");
    expect(sliceText("x", 0)).toBe("");
  });

  it("keeps the head and the tail of a long text within the limit", () => {
    const text = `HEAD${"x".repeat(5_000)}TAIL`;
    const clipped = clipMiddleText(text, 200);
    expect(clipped.length).toBeLessThanOrEqual(200);
    expect(clipped.startsWith("HEAD")).toBe(true);
    expect(clipped.endsWith("TAIL")).toBe(true);
    expect(clipped).toContain("chars omitted");
    expect(clipMiddleText("short", 200)).toBe("short");
  });

  it("never exceeds the limit or splits a pair, even below the size of the mark", () => {
    const text = `y${"😀".repeat(3_000)}`;
    for (let limit = 0; limit <= 300; limit += 1) {
      const clipped = clipMiddleText(text, limit);
      expect(clipped.length).toBeLessThanOrEqual(limit);
      expect(clipped).not.toMatch(LONE_SURROGATE);
    }
  });
});
