/**
 * The vendored Eve web_fetch Markdown path end to end, through the converter it really calls.
 *
 * Constructs covered:
 * - Every adversarial page found by the three Codex reviews of 5 October 2026 converts in bounded
 *   time without throwing: quadratic block output, whitespace runs in <pre> and in attributes,
 *   deep nesting behind stray closers, `<div/>` and CDATA, tags behind a lone `<`, deep lists with
 *   many line breaks, unclosed table cells, misnested blocks, empty links after a run of line
 *   breaks in <pre>. Text after such markup survives, uncut.
 * - A page past the output budget is reported as truncated, and so is an output whose only line
 *   the tool cuts to its line limit.
 * - Ordinary markup converts to readable Markdown.
 */
import { describe, expect, it } from "vitest";

import { truncateHead } from "../../vendor/eve/dist/src/execution/sandbox/truncate-output.js";
// @ts-expect-error -- vendored Eve module without declarations.
import { convertHtmlToMarkdown, convertHtmlToMarkdownBounded } from "../../vendor/eve/dist/src/execution/web-fetch/html.js";

const convertBounded = convertHtmlToMarkdownBounded as (html: string) => { markdown: string; truncated: boolean };
const convert = convertHtmlToMarkdown as (html: string) => string;
const PARAGRAPH = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.";

describe("web_fetch Markdown conversion", () => {
  it("converts ordinary markup", () => {
    expect(convert("<h1>Title</h1><p>Some <b>bold</b> and <a href=\"https://e.x/a\">link</a>.</p><ul><li>one</li><li>two</li></ul>"))
      .toBe("# Title\n\nSome **bold** and [link](https://e.x/a).\n\n- one\n- two");
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
    ["empty inline elements then a tail", "<i></i>".repeat(20_000) + "<p>TAIL</p>"],
    ["spaces and tabs in pre", "<pre>" + " \t".repeat(99_999) + "x</pre><p>TAIL</p>"],
    ["space runs between spans in pre", "<pre>" + (" ".repeat(64) + "<span></span>").repeat(2_500) + "x</pre><p>TAIL</p>"],
    ["190 000 spaces in an alt", "<img src=\"x\" alt=\"" + " ".repeat(190_000) + "x\"><p>TAIL</p>"],
    ["deep lists with many breaks", "<ul><li>".repeat(125) + "x<br>".repeat(10_000) + "</li></ul>".repeat(125) + "<p>TAIL</p>"],
    ["unclosed table cells", "<table><tr>" + "<td><p>cell".repeat(300) + "</table><p>TAIL</p>"],
    ["misnested blocks", "<span><div></span>".repeat(4_000) + "TAIL"],
    ["empty links after line breaks in pre", "<pre>" + "\n".repeat(40_000) + "<a></a>".repeat(20_000) + "TAIL</pre>"],
  ])("converts %s in bounded time", (_name, html) => {
    const started = performance.now();
    const result = convertBounded(html);
    // Turndown took 9-19 s on these; one linear pass is milliseconds, the limit only absorbs a
    // slow machine.
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(typeof result.markdown).toBe("string");
    if (html.includes("TAIL")) {
      expect(result.truncated).toBe(false);
      expect(result.markdown.replace(/\n```$/u, "").endsWith("TAIL")).toBe(true);
    }
  });

  it("reports a page past the output budget as truncated", () => {
    expect(convertBounded(`<p>${PARAGRAPH}</p>`.repeat(10_000)).truncated).toBe(true);
    expect(convertBounded(`<p>${PARAGRAPH}</p>`.repeat(100)).truncated).toBe(false);
    expect(truncateHead("x".repeat(5_000)).truncated).toBe(true);
    expect(truncateHead("x".repeat(2_000)).truncated).toBe(false);
  });
});
