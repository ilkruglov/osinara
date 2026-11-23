/**
 * Telegram captions: the limit counts what Telegram shows, not the HTML that carries it.
 *
 * Constructs covered:
 * - `telegramCaptionSchema`: a caption of up to 1 024 visible characters passes however much its
 *   Markdown and entities grow in HTML (final review, 22 November 2026: «Маша & Петя» × 80 was
 *   refused at 960 visible characters); a longer one is refused by the tool's input schema, so the
 *   model can shorten it before anything is reserved or sent.
 */
import { describe, expect, it } from "vitest";

import { renderTelegramMarkdownHtml } from "../telegram-markdown.js";
import { telegramCaptionSchema } from "./telegram-caption.js";

describe("telegramCaptionSchema", () => {
  it("measures a caption by its visible text", () => {
    const caption = "Маша & Петя ".repeat(80).trim();
    expect(caption.length).toBeLessThan(1_024);
    expect(renderTelegramMarkdownHtml(caption).length).toBeGreaterThan(1_024);
    expect(telegramCaptionSchema.safeParse(caption).success).toBe(true);
    // A link counts by its label: the address does not show.
    const linked = `[подробнее](https://example.com/${"a".repeat(1_500)})`;
    expect(telegramCaptionSchema.safeParse(linked).success).toBe(true);
  });

  it("refuses a caption longer than Telegram shows, with advice to shorten it", () => {
    const result = telegramCaptionSchema.safeParse("я".repeat(1_025));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("1024");
  });

  // Final review, 22 November 2026: zod ran the visible-length check after the source bound had
  // already failed, rendering 65 536 characters for 4 s on the agent's only thread.
  it("refuses an overlong source without rendering it", () => {
    const started = performance.now();
    const result = telegramCaptionSchema.safeParse("`a".repeat(32_768));
    expect(performance.now() - started).toBeLessThan(200);
    expect(result.error?.issues.map((issue) => issue.code)).toEqual(["too_big"]);
  });
});
