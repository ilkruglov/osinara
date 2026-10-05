/**
 * Linear HTML scanning for web pages fetched for the model.
 *
 * Exports:
 * - `htmlToText`: visible text of an HTML document, with block ends as line breaks.
 * - `decodeHtmlEntities`: named and numeric entities, leaving invalid ones as written.
 * - `boundHtmlForMarkdown`: the page without scripts, styles, SVG and markup declarations, cut to
 *   text, tag, depth and size budgets, with a flag telling whether anything was cut.
 *
 * Key construct:
 * - The extraction used regular expressions over the raw page; `<[^>]*>` restarts at every
 *   `<` and scans to the end when no `>` follows, so 64 KiB of `<` took over a second of
 *   synchronous CPU that no timeout could interrupt (security review, 5 October 2026). This is
 *   one forward pass: the next `<` and the next `>` are each searched only past the previous
 *   find, so the work is linear in the page whatever its markup.
 * - The Markdown converter of the vendored Eve (turndown) builds a DOM and its output grows
 *   quadratically with the number of blocks: 1 000 paragraphs took 71 ms, 10 000 took 5.4 s
 *   (Codex review, 5 October 2026). The model sees at most 50 KB of Markdown, about 330 such
 *   paragraphs, so the converter gets at most 200 000 characters of text and 15 000 tags; nesting
 *   is cut at 256 levels because deeper markup overflows its recursion.
 */
const SKIPPED_ELEMENTS = new Set(["noscript", "script", "style", "template"]);
// SVG carries no text for the model and is often the largest part of a page's markup.
const MARKDOWN_SKIPPED_ELEMENTS = new Set([...SKIPPED_ELEMENTS, "svg"]);
const LINE_BREAK_CLOSERS = new Set([
  "article", "aside", "blockquote", "details", "div", "figcaption", "figure", "footer", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "li", "main", "nav", "p", "pre", "section", "summary", "tr",
]);
// Inline elements join their text to the neighbours; any other tag separates words.
const INLINE_ELEMENTS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "del", "dfn", "em", "font", "i", "ins",
  "kbd", "mark", "q", "s", "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var",
]);
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
  "track", "wbr",
]);
// Line breaks and list items are blocks too: 15 000 of them convert in 0.16 s on the load stand,
// and a long Wikipedia article cut there still yields 280 KB of Markdown, past what the model sees.
export const MARKDOWN_SOURCE_MAX_TAGS = 15_000;
export const MARKDOWN_SOURCE_MAX_CHARACTERS = 2 * 1024 * 1024;
export const MARKDOWN_SOURCE_MAX_TEXT_CHARACTERS = 200_000;
export const MARKDOWN_SOURCE_MAX_DEPTH = 256;
// Runs of spaces longer than this are shortened: the converter strips trailing whitespace with a
// regular expression that restarts at every space of a run, so 200 000 spaces inside <pre> took
// 13 s (Codex review, 5 October 2026); runs of 64 keep any real indentation.
const MARKDOWN_SOURCE_MAX_SPACE_RUN = 64;
// `/>` closes an element only in SVG and MathML; `<div/>` or `<script/>` open one, as in a browser.
const FOREIGN_ELEMENTS = new Set(["math", "svg"]);
// Elements a browser closes implicitly when a sibling or a block starts: depth must follow the
// tree the converter builds, or `<li>` lists without closers would count as deep nesting.
const CLOSED_BY_BLOCK = new Set(["p"]);
const BLOCK_STARTS = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption",
  "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "menu",
  "nav", "ol", "p", "pre", "section", "table", "ul",
]);
const CLOSED_BY_SIBLING                                              = {
  dd: ["dd", "dt"],
  dt: ["dd", "dt"],
  li: ["li"],
  option: ["option"],
  td: ["td", "th"],
  th: ["td", "th"],
  tr: ["td", "th", "tr"],
};
const NAMED_ENTITIES                                   = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};
const MAX_CODE_POINT = 0x10ffff;

function isNameStart(code        )          {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);
}

// Custom elements carry `-` (`<script-widget>` is not a script); `_`, `:` and `.` occur too.
function isNameCharacter(code        )          {
  return isNameStart(code) || (code >= 0x30 && code <= 0x39) || code === 0x2d || code === 0x5f ||
    code === 0x3a || code === 0x2e;
}

            
                                                
                                                                                      
                     

/**
 * A forward-only HTML tokenizer: text, tags (name, closing, self-closing), and markup it drops
 * (comments, declarations, processing instructions, skipped elements with their content).
 * Every search starts past the previous one, so a page of any shape is scanned once.
 */
function* tokens(html        , skipped                     )                   {
  // The first `>` at or after a position, cached: positions only move forward, and a new search
  // starts only past the previous find, so all searches together read the page once.
  let cacheFrom = -1;
  let cacheAt = -1;
  const closeAfter = (from        )         => {
    if (cacheFrom !== -1 && from >= cacheFrom && (cacheAt === -1 || cacheAt >= from)) return cacheAt;
    cacheFrom = from;
    cacheAt = html.indexOf(">", from);
    return cacheAt;
  };
  // Text runs from `textStart`: a `<` that starts no markup stays inside the run, so a page of
  // lone `<` is one text token, not one per character.
  let textStart = 0;
  let search = 0;
  const flushText = function* (end        )                   {
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
    const end = closeAfter(nameEnd);
    if (end === -1) {
      // No tag can end anywhere after this point: the rest is text.
      textStart = open;
      break;
    }
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

export function decodeHtmlEntities(value        )         {
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

export function htmlToText(html        )         {
  const parts           = [];
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

                                       
                        
                   
                  
                            
 

/**
 * The page for the Markdown converter: no scripts, styles, SVG, comments or declarations, cut
 * before the first piece over any budget. `truncated` says that something was cut, so the
 * caller can tell the model the page is incomplete.
 */
function escapeText(text        )         {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

/**
 * Open elements as the converter's parser will nest them: a closer pops back to its element
 * (a closer of nothing open, `</br>` or `</bogus>`, changes nothing), `/>` closes only void and
 * foreign elements, and the implicit closes browsers apply to `p`, `li`, table cells and the like
 * are applied, so unclosed list items do not count as nesting.
 */
class OpenElements {
                   stack           = [];

  get depth()         {
    return this.stack.length;
  }

  open(name        , selfClosing         )       {
    if (VOID_ELEMENTS.has(name) || (selfClosing && FOREIGN_ELEMENTS.has(name))) return;
    const siblings = CLOSED_BY_SIBLING[name];
    if (siblings) {
      while (this.stack.length > 0 && siblings.includes(this.stack.at(-1) )) this.stack.pop();
    }
    if (BLOCK_STARTS.has(name) && CLOSED_BY_BLOCK.has(this.stack.at(-1) ?? "")) this.stack.pop();
    this.stack.push(name);
  }

  close(name        )       {
    const index = this.stack.lastIndexOf(name);
    if (index !== -1) this.stack.length = index;
  }
}

export function boundHtmlForMarkdown(
  html        ,
  limits                       = {
    maxCharacters: MARKDOWN_SOURCE_MAX_CHARACTERS,
    maxDepth: MARKDOWN_SOURCE_MAX_DEPTH,
    maxTags: MARKDOWN_SOURCE_MAX_TAGS,
    maxTextCharacters: MARKDOWN_SOURCE_MAX_TEXT_CHARACTERS,
  },
)                                       {
  const parts           = [];
  let kept = 0;
  let text = 0;
  let tags = 0;
  const elements = new OpenElements();
  const spaceRun = new RegExp(` {${MARKDOWN_SOURCE_MAX_SPACE_RUN + 1},}`, "gu");
  const shortRun = " ".repeat(MARKDOWN_SOURCE_MAX_SPACE_RUN);
  for (const token of tokens(html, MARKDOWN_SKIPPED_ELEMENTS)) {
    if (token.kind === "skip") continue;
    if (token.kind === "text") {
      // CDATA content is text to the reader; as markup it would open elements past the budgets.
      const piece = (token.cdata ? escapeText(token.text) : token.text).replace(spaceRun, shortRun);
      const room = Math.min(limits.maxTextCharacters - text, limits.maxCharacters - kept);
      if (piece.length > room) {
        parts.push(piece.slice(0, Math.max(0, room)));
        return { html: parts.join(""), truncated: true };
      }
      parts.push(piece);
      kept += piece.length;
      text += piece.length;
      continue;
    }
    tags += 1;
    if (token.closing) elements.close(token.name);
    else elements.open(token.name, token.selfClosing);
    if (tags > limits.maxTags || elements.depth > limits.maxDepth || kept + token.raw.length > limits.maxCharacters) {
      return { html: parts.join(""), truncated: true };
    }
    parts.push(token.raw);
    kept += token.raw.length;
  }
  return { html: parts.join(""), truncated: false };
}
