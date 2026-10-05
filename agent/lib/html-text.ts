/**
 * Linear HTML scanning for web pages fetched for the model.
 *
 * Exports:
 * - `tokens`: a forward-only tokenizer (text, tags, dropped markup), shared with html-markdown.ts.
 * - `htmlToText`: visible text of an HTML document, with block ends as line breaks.
 * - `decodeHtmlEntities`: numeric and all named HTML entities, leaving invalid ones as written.
 *
 * Key construct:
 * - The extraction used regular expressions over the raw page; `<[^>]*>` restarts at every
 *   `<` and scans to the end when no `>` follows, so 64 KiB of `<` took over a second of
 *   synchronous CPU that no timeout could interrupt (security review, 5 October 2026). This is
 *   one forward pass: every search starts past the previous find, so the work is linear in the
 *   page whatever its markup.
 */
import { HTML_NAMED_ENTITIES, HTML_NAMED_ENTITY_MAX_LENGTH } from "./html-entities.js";

const SKIPPED_ELEMENTS = new Set(["noscript", "script", "style", "template"]);
// SVG carries no text for the model and is often the largest part of a page's markup.
export const MARKDOWN_SKIPPED_ELEMENTS = new Set([...SKIPPED_ELEMENTS, "svg"]);
const LINE_BREAK_CLOSERS = new Set([
  "article", "aside", "blockquote", "details", "div", "figcaption", "figure", "footer", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "li", "main", "nav", "p", "pre", "section", "summary", "tr",
]);
// Inline elements join their text to the neighbours; any other tag separates words.
export const INLINE_ELEMENTS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "del", "dfn", "em", "font", "i", "ins",
  "kbd", "mark", "q", "s", "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var",
]);
// `/>` closes an element only in SVG and MathML; `<div/>` or `<script/>` open one, as in a browser.
const FOREIGN_ELEMENTS = new Set(["math", "svg"]);
const MAX_CODE_POINT = 0x10ffff;

function isNameStart(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);
}

// Custom elements carry `-` (`<script-widget>` is not a script); `_`, `:` and `.` occur too.
function isNameCharacter(code: number): boolean {
  return isNameStart(code) || (code >= 0x30 && code <= 0x39) || code === 0x2d || code === 0x5f ||
    code === 0x3a || code === 0x2e;
}

export type Token =
  | { kind: "text"; text: string; cdata?: true }
  | { kind: "tag"; closing: boolean; name: string; raw: string; selfClosing: boolean }
  | { kind: "skip" };

/**
 * A forward-only HTML tokenizer: text, tags (name, closing, self-closing), and markup it drops
 * (comments, declarations, processing instructions, skipped elements with their content).
 * Every search starts past the previous one, so a page of any shape is scanned once.
 */
export function* tokens(html: string, skipped: ReadonlySet<string>): Generator<Token> {
  // The first `>` at or after a position, cached: positions only move forward, and a new search
  // starts only past the previous find, so all searches together read the page once.
  let cacheFrom = -1;
  let cacheAt = -1;
  const closeAfter = (from: number): number => {
    if (cacheFrom !== -1 && from >= cacheFrom && (cacheAt === -1 || cacheAt >= from)) return cacheAt;
    cacheFrom = from;
    cacheAt = html.indexOf(">", from);
    return cacheAt;
  };
  // Text runs from `textStart`: a `<` that starts no markup stays inside the run, so a page of
  // lone `<` is one text token, not one per character.
  let textStart = 0;
  let search = 0;
  const flushText = function* (end: number): Generator<Token> {
    if (end > textStart) yield { kind: "text", text: html.slice(textStart, end) };
  };
  while (search < html.length) {
    const open = html.indexOf("<", search);
    if (open === -1) break;
    const next = html.charCodeAt(open + 1);
    const closing = next === 0x2f /* / */;
    const nameStart = open + (closing ? 2 : 1);
    if (next !== 0x21 && next !== 0x3f && !isNameStart(html.charCodeAt(nameStart))) {
      // `<` not followed by a tag name, `!` or `?` is text in HTML.
      search = open + 1;
      continue;
    }
    yield* flushText(open);
    if (next === 0x21 /* ! */) {
      if (html.startsWith("<!--", open)) {
        // An unterminated comment hides the rest of the page, as in a browser.
        const end = html.indexOf("-->", open + 4);
        if (end === -1) return;
        search = textStart = end + 3;
        yield { kind: "skip" };
        continue;
      }
      if (html.startsWith("<![CDATA[", open)) {
        const end = html.indexOf("]]>", open + 9);
        yield { cdata: true, kind: "text", text: html.slice(open + 9, end === -1 ? html.length : end) };
        if (end === -1) return;
        search = textStart = end + 3;
        continue;
      }
    }
    if (next === 0x21 || next === 0x3f) {
      // A declaration (`<!DOCTYPE …>`) or a processing instruction: no text for the model.
      const end = closeAfter(open + 2);
      if (end === -1) return;
      search = textStart = end + 1;
      yield { kind: "skip" };
      continue;
    }
    let nameEnd = nameStart;
    while (nameEnd < html.length && isNameCharacter(html.charCodeAt(nameEnd))) nameEnd += 1;
    const end = tagEnd(html, nameEnd);
    // A tag still open at the end of the page hides the rest, as in a browser.
    if (end === -1) return;
    const name = html.slice(nameStart, nameEnd).toLowerCase();
    const selfClosing = html.charCodeAt(end - 1) === 0x2f;
    search = textStart = end + 1;
    if (!closing && skipped.has(name) && !(selfClosing && FOREIGN_ELEMENTS.has(name))) {
      // The element's content is skipped up to its own end tag; a missing end tag skips the rest.
      const endTag = new RegExp(`</${name}\\s*>`, "giu");
      endTag.lastIndex = search;
      const found = endTag.exec(html);
      if (!found) return;
      search = textStart = found.index + found[0].length;
      yield { kind: "skip" };
      continue;
    }
    yield { closing, kind: "tag", name, raw: html.slice(open, end + 1), selfClosing };
  }
  yield* flushText(html.length);
}

/**
 * The `>` that ends a tag whose name ends at `from`, or -1 when the page ends first. A `>` inside
 * a quoted attribute value does not end it (`<a title="a > b" href="/r">`). The scan reads the
 * tag once and the next token starts after it, so the page is read once in all.
 */
function tagEnd(html: string, from: number): number {
  let index = from;
  let afterEquals = false;
  while (index < html.length) {
    const code = html.charCodeAt(index);
    if (code === 0x3e /* > */) return index;
    if (afterEquals && (code === 0x22 || code === 0x27)) {
      const close = html.indexOf(code === 0x22 ? "\"" : "'", index + 1);
      if (close === -1) return -1;
      index = close + 1;
      afterEquals = false;
      continue;
    }
    if (code === 0x3d /* = */) afterEquals = true;
    else if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0c && code !== 0x0d) afterEquals = false;
    index += 1;
  }
  return -1;
}

// Every alternative is bounded and ends at `;`, with no nested repetition: the scan is linear.
const ENTITY = new RegExp(
  `&(?:#(\\d{1,7})|#[xX]([\\da-fA-F]{1,6})|([A-Za-z][A-Za-z\\d]{0,${HTML_NAMED_ENTITY_MAX_LENGTH - 1}}));`,
  "gu",
);

export function decodeHtmlEntities(value: string): string {
  return value.replace(ENTITY, (entity, decimal, hex, named) => {
    if (decimal !== undefined || hex !== undefined) {
      const codePoint = decimal !== undefined ? Number(decimal) : Number.parseInt(hex, 16);
      return codePoint > 0 && codePoint <= MAX_CODE_POINT ? String.fromCodePoint(codePoint) : entity;
    }
    return HTML_NAMED_ENTITIES.get(named) ?? entity;
  });
}

export function htmlToText(html: string): string {
  const parts: string[] = [];
  for (const token of tokens(html, SKIPPED_ELEMENTS)) {
    if (token.kind === "text") parts.push(token.text);
    else if (token.kind === "skip") parts.push(" ");
    else if (token.name === "br" || (token.closing && LINE_BREAK_CLOSERS.has(token.name))) parts.push("\n");
    else if (!INLINE_ELEMENTS.has(token.name)) parts.push(" ");
  }
  return decodeHtmlEntities(parts.join(""))
    .replace(/[\t ]+/gu, " ")
    .replace(/ ?\n ?/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
