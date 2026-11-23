/**
 * Telegram caption Markdown rendering regression tests.
 *
 * Coverage:
 * - Safe Telegram HTML conversion for model-authored file captions.
 * - Readable tables and bounded pathological emoji repetition.
 * - A heading marker with nothing after it is text, not an endless loop (final review,
 *   22 November 2026: «# » hung the process, and a caption schema renders on every tool call).
 */
import { describe, expect, it } from "vitest";

import { renderTelegramMarkdownHtml } from "./telegram-markdown.js";

describe("renderTelegramMarkdownHtml", () => {
  it.each(["# ", "## ", "###   ", "до\n# \nпосле", "# a\u2028b", "#\u2029x"])(
    "renders an empty or broken heading %j",
    (markdown) => {
      expect(typeof renderTelegramMarkdownHtml(markdown)).toBe("string");
    },
    1_000,
  );

  it("renders useful Markdown and escapes raw HTML", () => {
    const html = renderTelegramMarkdownHtml(
      [
        "# Результат",
        "",
        "**Важно:** *текст* и `код`.",
        "",
        "> Цитата",
        "",
        "[Сайт](https://example.com?a=1&b=2) <script>alert(1)</script>",
        "",
        "```ts",
        "const value = 1 < 2;",
        "```",
      ].join("\n"),
    );

    expect(html).toContain("<b>Результат</b>");
    expect(html).toContain("<b>Важно:</b> <i>текст</i> и <code>код</code>.");
    expect(html).toContain("<blockquote>Цитата</blockquote>");
    expect(html).toContain('<a href="https://example.com?a=1&amp;b=2">Сайт</a>');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("<pre><code>const value = 1 &lt; 2;</code></pre>");
  });

  // Repeat review, 23 November 2026: the link took the code's placeholder into its label and the
  // code was restored before the link, so Telegram got private-use marks and a «0».
  // Telegram lets no code entity sit inside a link: the label's code is shown as plain text.
  it("renders code inside a link label", () => {
    expect(renderTelegramMarkdownHtml("[`npm ci`](https://example.com) и `ещё`")).toBe(
      '<a href="https://example.com">npm ci</a> и <code>ещё</code>',
    );
    // The code's text stays literal: its asterisks are not read as emphasis.
    expect(renderTelegramMarkdownHtml("[`**x**`](https://e.com)")).toBe(
      '<a href="https://e.com">**x**</a>',
    );
  });

  // Digits between two placeholders read as a third one when placeholders were restored one index
  // at a time, in either order (repeat review, 23 November 2026).
  it.each([
    ["`a`1`b`", "<code>a</code>1<code>b</code>"],
    ["`x`2`y` `z`", "<code>x</code>2<code>y</code> <code>z</code>"],
    ["[l](https://e.com)0`c`", '<a href="https://e.com">l</a>0<code>c</code>'],
    ["[`a`1`b`](https://e.com)", '<a href="https://e.com">a1b</a>'],
  ])("restores %j whatever digits stand between its parts", (markdown, html) => {
    expect(renderTelegramMarkdownHtml(markdown)).toBe(html);
  });

  // A link's address is read before code (CommonMark): its backticks are characters of the address.
  it("keeps backticks in a link address", () => {
    expect(renderTelegramMarkdownHtml("[x](https://example.com/`p`)")).toBe(
      '<a href="https://example.com/`p`">x</a>',
    );
  });

  // Repeat review, 23 November 2026: crossing emphasis gave HTML Telegram refuses whole («Unmatched
  // end tag»), and the file did not go; code inside a link loses the link. Such a caption goes as
  // plain text instead.
  it.each([
    ["Итог: **сумма _1 200** ₽_", "Итог: **сумма _1 200** ₽_"],
    ["**a ~~b** c~~", "**a ~~b** c~~"],
    ["[``npm ci``](https://example.com/docs)", "[``npm ci``](https://example.com/docs)"],
    ["a < b & **c _d** e_", "a &lt; b &amp; **c _d** e_"],
  ])("sends %j as plain text when Telegram would refuse its tags", (markdown, plain) => {
    expect(renderTelegramMarkdownHtml(markdown)).toBe(plain);
  });

  // Repeat review, 23 November 2026: Telegram reads a NUL as the end of the attribute and refuses
  // the caption whole, and drops a link to an http host without a dot, its address with it. Such an
  // address stays literal text, so the reader still sees it.
  it.each([
    "[отчёт](https://example.org/a\u0000b)",
    "[отчёт](https://example.org/a\u0007b)",
    "[акт](http://intranet/report)",
    "[акт](https://localhost:8080/a)",
  ])("keeps the address %j as text, not a link", (markdown) => {
    expect(renderTelegramMarkdownHtml(markdown)).not.toContain("<a ");
  });

  it.each([
    ["[акт](https://e.org/report)", '<a href="https://e.org/report">акт</a>'],
    ["[узел](http://[::1]:8080/a)", '<a href="http://[::1]:8080/a">узел</a>'],
  ])("links %j", (markdown, html) => {
    expect(renderTelegramMarkdownHtml(markdown)).toBe(html);
  });

  // Telegram keeps the first 100 entities of a caption and drops the rest, a link's address with it
  // (repeat review, 23 November 2026: the 101st link of a list became bare text).
  it("sends a caption of more than 100 formatted parts as plain text", () => {
    const links = (count: number) =>
      Array.from({ length: count }, (_, index) => `[${index}](https://e.org/${index})`).join(" ");
    expect(renderTelegramMarkdownHtml(links(100))).toContain('<a href="https://e.org/99">99</a>');
    expect(renderTelegramMarkdownHtml(links(101))).toBe(links(101));
  });

  it("renders GFM tables as preformatted text and collapses repeated status emoji", () => {
    const html = renderTelegramMarkdownHtml(
      ["| Шаг | Статус |", "| --- | --- |", `| Открытие | ${"❌ ".repeat(80)}|`].join("\n"),
    );

    expect(html).toContain("<pre>Шаг | Статус\nОткрытие | ❌ × 80</pre>");
    expect(html).not.toContain("---");
    expect(html).not.toContain("❌ ❌ ❌");
  });
});
