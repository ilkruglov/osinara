/**
 * The vendored Eve web_fetch Markdown path end to end: budgets, then the real converter.
 *
 * Constructs covered:
 * - Every adversarial page found by the two Codex reviews of 5 October 2026 goes through the
 *   real converter (turndown) in bounded time without throwing: quadratic block output, long runs
 *   of spaces in <pre>, deep nesting hidden behind stray closers, `<div/>` and CDATA, tags hidden
 *   behind a lone `<`. A page cut by the budgets is reported as truncated.
 * - Ordinary markup converts to the same Markdown as before.
 */
import { describe, expect, it } from "vitest";

// @ts-expect-error -- vendored Eve module without declarations.
import { convertHtmlToMarkdown, convertHtmlToMarkdownBounded } from "../../vendor/eve/dist/src/execution/web-fetch/html.js";

const convertBounded = convertHtmlToMarkdownBounded as (html: string) => { markdown: string; truncated: boolean };
const convert = convertHtmlToMarkdown as (html: string) => string;
const PARAGRAPH = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.";

describe("web_fetch Markdown conversion", () => {
  it("converts ordinary markup as before", () => {
    expect(convert("<h1>Title</h1><p>Some <b>bold</b> and <a href=\"https://e.x/a\">link</a>.</p><ul><li>one</li><li>two</li></ul>"))
      .toBe("# Title\n\nSome **bold** and [link](https://e.x/a).\n\n-   one\n-   two");
    expect(convertBounded("<p>short</p>")).toEqual({ markdown: "short", truncated: false });
  });

  it.each([
    ["ten thousand paragraphs", `<p>${PARAGRAPH}</p>`.repeat(10_000)],
    ["200 000 spaces in pre", `<pre>${" ".repeat(199_999)}x</pre>`],
    ["nesting behind stray closers", "<div></bogus>".repeat(6_000) + "x"],
    ["nesting behind </br>", "<div></br>".repeat(6_000) + "x"],
    ["nesting by <div/>", "<div/>".repeat(6_000) + "x"],
    ["nesting inside CDATA", "<![CDATA[" + "<div>".repeat(6_000) + "x]]>"],
    ["plain deep nesting", "<div>".repeat(3_000) + "x"],
    ["tags behind lone <", "< <br>".repeat(100_000)],
    ["five megabytes of <p>", "<p>".repeat(1_747_626)],
    ["five megabytes of <", "<".repeat(5 * 1024 * 1024)],
    ["empty inline elements then a tail", "<i></i>".repeat(20_000) + "<p>IMPORTANT TAIL</p>"],
  ])("converts %s in bounded time", (_name, html) => {
    const started = performance.now();
    const result = convertBounded(html);
    // Seconds before; a generous limit so a slow machine does not fail it, far under the old cost.
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(typeof result.markdown).toBe("string");
  });

  it("reports a page cut by the budgets as truncated", () => {
    expect(convertBounded(`<p>${PARAGRAPH}</p>`.repeat(10_000)).truncated).toBe(true);
    expect(convertBounded("<i></i>".repeat(20_000) + "<p>IMPORTANT TAIL</p>").truncated).toBe(true);
  });
});
