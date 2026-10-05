/**
 * Linear HTML to plain text.
 *
 * Constructs covered:
 * - Visible text with block ends as line breaks; script, style, template and noscript content
 *   and comments are skipped; entities decode, invalid numeric ones stay as written.
 * - Adversarial markup (runs of `<` without `>`, unterminated comments and scripts, long tag
 *   names) is handled in linear time: a megabyte of it finishes far under the old cost of
 *   64 KiB.
 */
import { describe, expect, it } from "vitest";

import { boundHtmlForMarkdown, decodeHtmlEntities, htmlToText } from "./html-text.js";

describe("htmlToText", () => {
  it("keeps visible text and breaks lines at block ends", () => {
    expect(htmlToText("<article><h1>Title</h1><p>Body &amp; more</p></article>")).toBe("Title\nBody & more");
    expect(htmlToText("a<br>b<BR/>c")).toBe("a\nb\nc");
    expect(htmlToText("<p>one</p>\n\n\n\n<p>two</p>")).toBe("one\n\ntwo");
  });

  it("skips scripts, styles, templates and comments", () => {
    expect(htmlToText("x<script type=\"a\">var a = '<p>';</script>y<style>p{}</STYLE >z<!-- c -->w"))
      .toBe("x y z w");
    expect(htmlToText("before<template><p>hidden</p></template>after")).toBe("before after");
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
    ["unterminated comments", "<!--".repeat(262_144)],
    ["script openers without end tags", "<script>".repeat(131_072)],
    ["many tags", "<p>x</p>".repeat(131_072)],
    ["entities without semicolons", "&aaaaaaaaaaa".repeat(87_381)],
  ])("handles a megabyte of %s in linear time", (_name, html) => {
    const started = performance.now();
    htmlToText(html);
    // The regex version took over a second for 64 KiB of `<`; a linear pass over a megabyte
    // is tens of milliseconds even on a slow core.
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("boundHtmlForMarkdown", () => {
  it("drops scripts, styles, SVG and comments and keeps the rest of the markup", () => {
    expect(boundHtmlForMarkdown("<h1>T</h1><script>x<p></script><svg><text>s</text></svg><!-- c --><p>B</p>"))
      .toBe("<h1>T</h1><p>B</p>");
  });

  it("cuts before the first tag over the tag budget and at the character budget", () => {
    expect(boundHtmlForMarkdown("<p>a</p><p>b</p><p>c</p>", { maxCharacters: 1_000, maxTags: 3 })).toBe("<p>a</p><p>b");
    expect(boundHtmlForMarkdown("<p>abcdef</p>", { maxCharacters: 5, maxTags: 100 })).toBe("<p>ab");
  });

  it("bounds a megabyte of adversarial markup in linear time", () => {
    for (const html of ["<p>".repeat(349_525), "<".repeat(1_048_576), "<svg>".repeat(209_715)]) {
      const started = performance.now();
      boundHtmlForMarkdown(html);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });
});
