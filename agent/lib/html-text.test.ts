/**
 * Linear HTML scanning.
 *
 * Constructs covered:
 * - Visible text with block ends as line breaks and inline elements joined to their neighbours;
 *   script, style, template and noscript content, comments and declarations are dropped; CDATA
 *   keeps its text; custom elements with `-` are not mistaken for skipped ones; a self-closing
 *   skipped element hides nothing; entities decode, invalid numeric ones stay as written.
 * - The Markdown source is cut at text, tag, depth and size budgets and says that it was cut;
 *   a lone `<` cannot hide tags from the tag budget.
 * - Adversarial markup is handled in linear time.
 */
import { describe, expect, it } from "vitest";

import { boundHtmlForMarkdown, decodeHtmlEntities, htmlToText, type MarkdownSourceLimits } from "./html-text.js";

const WIDE: MarkdownSourceLimits = { maxCharacters: 1_000_000, maxDepth: 1_000, maxTags: 1_000_000, maxTextCharacters: 1_000_000 };
const WIDE_DEPTH_256: MarkdownSourceLimits = { ...WIDE, maxDepth: 256 };

describe("htmlToText", () => {
  it("keeps visible text, breaks lines at block ends and joins inline elements", () => {
    expect(htmlToText("<article><h1>Title</h1><p>Body &amp; more</p></article>")).toBe("Title\nBody & more");
    expect(htmlToText("a<br>b<BR/>c")).toBe("a\nb\nc");
    expect(htmlToText("<p>one</p>\n\n\n\n<p>two</p>")).toBe("one\n\ntwo");
    expect(htmlToText("x<b>y</b>z <a href=\"/u\">link</a>s")).toBe("xyz links");
    expect(htmlToText("cell<td>next")).toBe("cell next");
  });

  it("drops scripts, styles, templates, comments and declarations and keeps CDATA text", () => {
    expect(htmlToText("x<script type=\"a\">var a = '<p>';</script>y<style>p{}</STYLE >z<!-- c -->w"))
      .toBe("x y z w");
    expect(htmlToText("<!DOCTYPE html><?xml version=\"1.0\"?>before<template><p>hidden</p></template>after"))
      .toBe("before after");
    expect(htmlToText("a<![CDATA[raw <text>]]>b")).toBe("araw <text>b");
  });

  it("keeps the content of custom elements and of self-closing foreign elements", () => {
    expect(htmlToText("<script-widget>visible</script-widget><p>after</p>")).toBe("visible after");
    expect(htmlToText("<svg/><p>after</p>")).toBe("after");
    // `/>` does not close a script in HTML: a browser runs everything after it as the script.
    expect(htmlToText("before<script/><p>hidden</p>")).toBe("before");
  });

  it("treats a lone < as text and drops what an unterminated comment or script hides", () => {
    expect(htmlToText("1 < 2 and 3 > 2")).toBe("1 < 2 and 3 > 2");
    expect(htmlToText("a <!-- never closed <p>b</p>")).toBe("a");
    expect(htmlToText("a <script>while(true){}")).toBe("a");
  });

  it("decodes entities and leaves invalid ones as written", () => {
    expect(decodeHtmlEntities("&lt;b&gt; &#1055;&#x438; &quot;x&quot; &unknown;")).toBe("<b> Пи \"x\" &unknown;");
    expect(decodeHtmlEntities("&#0; &#9999999; &#x110000;")).toBe("&#0; &#9999999; &#x110000;");
  });

  it.each([
    ["runs of < without >", "<".repeat(1_048_576)],
    ["< followed by letters without >", "<a".repeat(524_288)],
    ["lone < before a far >", "< ".repeat(524_287) + ">"],
    ["unterminated comments", "<!--".repeat(262_144)],
    ["unterminated declarations", "<!x".repeat(349_525)],
    ["script openers without end tags", "<script>".repeat(131_072)],
    ["many tags", "<p>x</p>".repeat(131_072)],
    ["entities without semicolons", "&aaaaaaaaaaa".repeat(87_381)],
  ])("handles a megabyte of %s in linear time", (_name, html) => {
    const started = performance.now();
    htmlToText(html);
    boundHtmlForMarkdown(html);
    // The regex version took over a second for 64 KiB of `<`; a linear pass over a megabyte
    // is tens of milliseconds even on a slow core.
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("boundHtmlForMarkdown", () => {
  it("drops scripts, styles, SVG, comments and declarations and keeps the rest of the markup", () => {
    expect(boundHtmlForMarkdown("<!DOCTYPE html><h1>T</h1><script>x<p></script><svg><text>s</text></svg><!-- c --><p>B</p>"))
      .toEqual({ html: "<h1>T</h1><p>B</p>", truncated: false });
  });

  it("cuts at the tag, text, size and depth budgets and says so", () => {
    expect(boundHtmlForMarkdown("<p>a</p><p>b</p><p>c</p>", { ...WIDE, maxTags: 3 }))
      .toEqual({ html: "<p>a</p><p>b", truncated: true });
    expect(boundHtmlForMarkdown("<p>abcdef</p><p>gh</p>", { ...WIDE, maxTextCharacters: 4 }))
      .toEqual({ html: "<p>abcd", truncated: true });
    expect(boundHtmlForMarkdown("<p>abcdef</p>", { ...WIDE, maxCharacters: 5 }))
      .toEqual({ html: "<p>ab", truncated: true });
    expect(boundHtmlForMarkdown("<div><div><div>deep</div></div></div><br><img>", { ...WIDE, maxDepth: 2 }))
      .toEqual({ html: "<div><div>", truncated: true });
    expect(boundHtmlForMarkdown("<div><br><img/><p>x</p></div>", { ...WIDE, maxDepth: 2 }))
      .toEqual({ html: "<div><br><img/><p>x</p></div>", truncated: false });
  });

  it("follows nesting as the parser builds it", () => {
    // A closer of nothing open does not undo nesting; `/>` does not close a div.
    expect(boundHtmlForMarkdown("<div></bogus>".repeat(300), WIDE_DEPTH_256).truncated).toBe(true);
    expect(boundHtmlForMarkdown("<div></br>".repeat(300), WIDE_DEPTH_256).truncated).toBe(true);
    expect(boundHtmlForMarkdown("<div/>".repeat(300), WIDE_DEPTH_256).truncated).toBe(true);
    // Implicitly closed siblings are not nesting.
    expect(boundHtmlForMarkdown("<ul>" + "<li>item".repeat(1_000) + "</ul>", WIDE_DEPTH_256).truncated).toBe(false);
    expect(boundHtmlForMarkdown("<p>one".repeat(1_000), WIDE_DEPTH_256).truncated).toBe(false);
    expect(boundHtmlForMarkdown("<table>" + "<tr><td>a<td>b".repeat(500) + "</table>", WIDE_DEPTH_256).truncated).toBe(false);
    expect(boundHtmlForMarkdown("<p>a<br/><img src=x/>b</p>".repeat(1_000), WIDE_DEPTH_256).truncated).toBe(false);
  });

  it("passes CDATA on as escaped text and shortens long runs of spaces", () => {
    const { html, truncated } = boundHtmlForMarkdown("<![CDATA[" + "<div>".repeat(6_000) + "x]]>", WIDE_DEPTH_256);
    expect(truncated).toBe(false);
    expect(html.startsWith("&lt;div&gt;&lt;div&gt;")).toBe(true);
    expect(boundHtmlForMarkdown(`<pre>${" ".repeat(1_000)}x</pre>`, WIDE).html).toBe(`<pre>${" ".repeat(64)}x</pre>`);
  });

  it("counts every tag even after a lone <", () => {
    const { html, truncated } = boundHtmlForMarkdown("< <br>".repeat(10), { ...WIDE, maxTags: 3 });
    expect(truncated).toBe(true);
    expect(html.match(/<br>/gu)).toHaveLength(3);
  });
});
