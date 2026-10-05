/**
 * Linear HTML to plain text for web pages fetched for the model.
 *
 * Exports:
 * - `htmlToText`: visible text of an HTML document, with block ends as line breaks.
 * - `decodeHtmlEntities`: named and numeric entities, leaving invalid ones as written.
 * - `boundHtmlForMarkdown`: the page without scripts, styles and comments, cut to a tag and
 *   byte budget, for the Markdown converter whose cost grows with every element.
 *
 * Key construct:
 * - The extraction used regular expressions over the raw page; `<[^>]*>` restarts at every
 *   `<` and scans to the end when no `>` follows, so 64 KiB of `<` took over a second of
 *   synchronous CPU that no timeout could interrupt (security review, 5 October 2026). This is
 *   one forward pass: every search starts where the previous one ended, and a search that finds
 *   nothing ends the pass, so the work is linear in the page whatever its markup.
 */
const SKIPPED_ELEMENTS = new Set(["noscript", "script", "style", "template"]);
// The Markdown converter builds a DOM: about 5 µs an element on the load stand, so five
// megabytes of `<p>` blocked the event loop for eight seconds (twenty and more on production's
// core). Real heavy pages stay well inside these budgets once scripts and styles are gone: a
// long Wikipedia article is 30 000 tags and 1.8 MB, a news front page 4 000 tags.
export const MARKDOWN_SOURCE_MAX_TAGS = 40_000;
export const MARKDOWN_SOURCE_MAX_CHARACTERS = 2 * 1024 * 1024;
// SVG carries no text for the model and is often the largest part of a page's markup.
const MARKDOWN_SKIPPED_ELEMENTS = new Set([...SKIPPED_ELEMENTS, "svg"]);
const LINE_BREAK_CLOSERS = new Set([
  "article", "aside", "blockquote", "details", "div", "figcaption", "figure", "footer", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "li", "main", "nav", "p", "pre", "section", "summary", "tr",
]);
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};
const MAX_CODE_POINT = 0x10ffff;

function isNameCharacter(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || (code >= 0x30 && code <= 0x39);
}

/** The lower-case tag name starting at `from`, and where it ends. */
function tagName(html: string, from: number): { end: number; name: string } {
  let end = from;
  while (end < html.length && isNameCharacter(html.charCodeAt(end))) end += 1;
  return { end, name: html.slice(from, end).toLowerCase() };
}

export function decodeHtmlEntities(value: string): string {
  // Every alternative is bounded by `;` or a non-matching character after `&`, with no nested
  // repetition: the scan is linear.
  return value.replace(/&(?:#(\d{1,7})|#x([\da-f]{1,6})|([a-z]{1,10}));/giu, (entity, decimal, hex, named) => {
    if (decimal !== undefined || hex !== undefined) {
      const codePoint = decimal !== undefined ? Number(decimal) : Number.parseInt(hex, 16);
      return codePoint > 0 && codePoint <= MAX_CODE_POINT ? String.fromCodePoint(codePoint) : entity;
    }
    return NAMED_ENTITIES[String(named).toLowerCase()] ?? entity;
  });
}

export function htmlToText(html: string): string {
  const parts: string[] = [];
  let position = 0;
  while (position < html.length) {
    const open = html.indexOf("<", position);
    if (open === -1) {
      parts.push(html.slice(position));
      break;
    }
    parts.push(html.slice(position, open));
    if (html.startsWith("<!--", open)) {
      // An unterminated comment hides the rest of the page, as in a browser.
      const close = html.indexOf("-->", open + 4);
      if (close === -1) break;
      position = close + 3;
      parts.push(" ");
      continue;
    }
    const close = html.indexOf(">", open + 1);
    if (close === -1) {
      // No tag can end anywhere after this point: the rest is text.
      parts.push(html.slice(open));
      break;
    }
    const closing = html.charCodeAt(open + 1) === 0x2f;
    const { name } = tagName(html, open + (closing ? 2 : 1));
    position = close + 1;
    if (name === "") {
      // `<` not followed by a tag name is text in HTML.
      parts.push(html.slice(open, close + 1));
      continue;
    }
    if (!closing && SKIPPED_ELEMENTS.has(name)) {
      // The element's content is skipped up to its own end tag; a missing end tag skips the rest.
      const endTag = new RegExp(`</${name}\\s*>`, "giu");
      endTag.lastIndex = position;
      const found = endTag.exec(html);
      if (!found) break;
      position = found.index + found[0].length;
      parts.push(" ");
      continue;
    }
    parts.push(name === "br" || (closing && LINE_BREAK_CLOSERS.has(name)) ? "\n" : " ");
  }
  return decodeHtmlEntities(parts.join(""))
    .replace(/[\t ]+/gu, " ")
    .replace(/ ?\n ?/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/**
 * The page without scripts, styles, SVG and comments, cut before the first tag over the budget.
 * The model sees at most 50 KB of Markdown, so a page cut this far still fills it.
 */
export function boundHtmlForMarkdown(
  html: string,
  limits: { maxCharacters: number; maxTags: number } = {
    maxCharacters: MARKDOWN_SOURCE_MAX_CHARACTERS,
    maxTags: MARKDOWN_SOURCE_MAX_TAGS,
  },
): string {
  const parts: string[] = [];
  let kept = 0;
  let tags = 0;
  let position = 0;
  const keep = (text: string): boolean => {
    if (kept + text.length > limits.maxCharacters) {
      parts.push(text.slice(0, limits.maxCharacters - kept));
      return false;
    }
    parts.push(text);
    kept += text.length;
    return true;
  };
  while (position < html.length) {
    const open = html.indexOf("<", position);
    if (open === -1) {
      keep(html.slice(position));
      break;
    }
    if (!keep(html.slice(position, open))) break;
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      if (close === -1) break;
      position = close + 3;
      continue;
    }
    const close = html.indexOf(">", open + 1);
    if (close === -1) {
      keep(html.slice(open));
      break;
    }
    const closing = html.charCodeAt(open + 1) === 0x2f;
    const { name } = tagName(html, open + (closing ? 2 : 1));
    position = close + 1;
    if (name !== "" && !closing && MARKDOWN_SKIPPED_ELEMENTS.has(name)) {
      const endTag = new RegExp(`</${name}\\s*>`, "giu");
      endTag.lastIndex = position;
      const found = endTag.exec(html);
      if (!found) break;
      position = found.index + found[0].length;
      continue;
    }
    if (name !== "") {
      tags += 1;
      if (tags > limits.maxTags) break;
    }
    if (!keep(html.slice(open, close + 1))) break;
  }
  return parts.join("");
}
