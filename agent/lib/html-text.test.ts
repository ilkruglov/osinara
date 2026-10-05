/**
 * Linear HTML scanning.
 *
 * Constructs covered:
 * - Visible text with block ends as line breaks and inline elements joined to their neighbours;
 *   script, style, template and noscript content, comments and declarations are dropped; CDATA
 *   keeps its text; custom elements with `-` are not mistaken for skipped ones; a self-closing
 *   skipped element hides nothing; entities decode, invalid numeric ones stay as written.
 * - Markdown: headings, paragraphs, line breaks, rules, nested lists with capped indentation,
 *   quotes, fenced and inline code, emphasis, links (not nested, no `javascript:`), images (no
 *   `data:`), table rows; attributes are read with quotes, without them and across line breaks.
 * - The Markdown is cut at the output budget and says that it was cut.
 * - Adversarial markup is handled in linear time by both conversions.
 */
import { describe, expect, it } from "vitest";

import { decodeHtmlEntities, htmlToMarkdown, htmlToText } from "./html-text.js";

const markdown = (html: string) => htmlToMarkdown(html).markdown;

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
    htmlToMarkdown(html);
    // The regex version took over a second for 64 KiB of `<`; a linear pass over a megabyte
    // is tens of milliseconds even on a slow core.
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("htmlToMarkdown", () => {
  it("converts headings, paragraphs, emphasis, links and lists", () => {
    expect(markdown("<h1>Title</h1><p>Some <b>bold</b>, <em>it</em> and <a href=\"https://e.x/a?x=1&amp;y=2\">link</a>.</p><ul><li>one</li><li>two</li></ul>"))
      .toBe("# Title\n\nSome **bold**, *it* and [link](https://e.x/a?x=1&y=2).\n\n- one\n- two");
    expect(markdown("<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>")).toBe("1. a\n  - b\n2. c");
    expect(markdown("a<br>b<hr>c<div>d</div>e<span>f</span>g")).toBe("a\nb\n\n---\n\nc\n\nd\n\nefg");
  });

  it("keeps preformatted text, inline code, quotes and table rows", () => {
    expect(markdown("<pre><code>line1\n  line2</code></pre><p>x <code>y</code></p>")).toBe("```\nline1\n  line2\n```\n\nx `y`");
    expect(markdown("<blockquote><p>quoted</p></blockquote>after")).toBe("> quoted\n\nafter");
    expect(markdown("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>")).toBe("A | B\n1 | 2");
  });

  it("reads attributes in every form and drops script links and inline images", () => {
    expect(markdown("<img\nsrc=/i.png alt='pic &amp; co'>")).toBe("![pic & co](/i.png)");
    expect(markdown("<a href=\"javascript:x\">js</a> <img src=\"data:image/png;base64,AA\" alt=\"inline\">")).toBe("js inline");
    expect(markdown("<a href=\"/r\"><img src=a.png alt=A></a>")).toBe("[![A](a.png)](/r)");
    expect(markdown("<a href=\" JavaScript:x\">js</a> <a href=\"/a b)(c\">t</a>")).toBe("js [t](/a%20b%29%28c)");
    // A link inside a link is not nesting: the inner start tag is ignored.
    expect(markdown("<a href=\"/a\">x <a href=\"/b\">y</a> z</a>")).toBe("[x y](/a) z");
  });

  it("drops scripts, styles, SVG and comments and keeps CDATA as text", () => {
    expect(markdown("<h1>T</h1><script>x<p></script><svg><text>s</text></svg><!-- c --><p>B <![CDATA[<i>raw</i>]]></p>"))
      .toBe("# T\n\nB <i>raw</i>");
  });

  it("caps nesting markers and cuts at the output budget", () => {
    const nested = markdown("<ul><li>".repeat(50) + "deep" + "</li></ul>".repeat(50));
    expect(nested.split("\n").at(-1)).toBe(`${"  ".repeat(8)}- deep`);
    expect(markdown("<blockquote>".repeat(20) + "q")).toBe(`${"> ".repeat(4)}q`);
    expect(htmlToMarkdown("<p>abcdef</p>".repeat(10), 20)).toEqual({ markdown: "abcdef\n\nabcdef\n\nabcdef", truncated: true });
    expect(htmlToMarkdown("<p>abc</p>", 20)).toEqual({ markdown: "abc", truncated: false });
  });
});
