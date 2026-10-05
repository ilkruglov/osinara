/**
 * Linear HTML conversion for web pages fetched for the model.
 *
 * Exports:
 * - `htmlToText`: visible text of an HTML document, with block ends as line breaks.
 * - `htmlToMarkdown`: the same pass producing Markdown (headings, lists, links, images, emphasis,
 *   code, quotes, tables as rows), cut at an output budget with a flag telling whether it was.
 * - `decodeHtmlEntities`: named and numeric entities, leaving invalid ones as written.
 *
 * Key construct:
 * - The extraction used regular expressions over the raw page; `<[^>]*>` restarts at every
 *   `<` and scans to the end when no `>` follows, so 64 KiB of `<` took over a second of
 *   synchronous CPU that no timeout could interrupt (security review, 5 October 2026). This is
 *   one forward pass: the next `<` and the next `>` are each searched only past the previous
 *   find, so the work is linear in the page whatever its markup.
 * - Markdown used to come from the vendored turndown, which builds a DOM, recurses over it and
 *   trims whitespace with regular expressions that restart at every space of a run: three Codex
 *   reviews (5 October 2026) kept finding pages inside any budget that blocked the event loop for
 *   9-19 s or overflowed its stack. The Markdown here comes from the same single pass, with no
 *   tree, no recursion and no regular expression that can backtrack, so no page can do that.
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
// `/>` closes an element only in SVG and MathML; `<div/>` or `<script/>` open one, as in a browser.
const FOREIGN_ELEMENTS = new Set(["math", "svg"]);
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

/** One attribute's value from a raw start tag, read in a single forward scan. */
function attribute(raw        , wanted        )                {
  // Past `<` and the element name.
  let index = 1;
  while (index < raw.length && !/[\s/>]/u.test(raw[index] )) index += 1;
  while (index < raw.length) {
    while (index < raw.length && /[\s/]/u.test(raw[index] )) index += 1;
    if (index >= raw.length || raw[index] === ">") return null;
    const nameStart = index;
    while (index < raw.length && !/[\s=/>]/u.test(raw[index] )) index += 1;
    const name = raw.slice(nameStart, index).toLowerCase();
    while (index < raw.length && /\s/u.test(raw[index] )) index += 1;
    let value = "";
    if (raw[index] === "=") {
      index += 1;
      while (index < raw.length && /\s/u.test(raw[index] )) index += 1;
      const quote = raw[index];
      if (quote === "\"" || quote === "'") {
        const end = raw.indexOf(quote, index + 1);
        const stop = end === -1 ? raw.length : end;
        value = raw.slice(index + 1, stop);
        index = stop + 1;
      } else {
        const valueStart = index;
        while (index < raw.length && !/[\s>]/u.test(raw[index] )) index += 1;
        value = raw.slice(valueStart, index);
      }
    }
    if (name === wanted) return value;
  }
  return null;
}

/**
 * An attribute URL as a Markdown link target: entities decoded, whitespace and the characters that
 * end or open a link target percent-encoded, cut to a length; script and inline-data schemes give
 * nothing. The result only reaches the model, but a `)` in it would still end the link early.
 */
function markdownUrl(raw               )         {
  const url = decodeHtmlEntities(raw ?? "").trim().slice(0, MARKDOWN_MAX_URL);
  const scheme = url.slice(0, 12).toLowerCase().replace(/[\t\n\r ]/gu, "");
  if (/^(?:javascript|vbscript|data):/u.test(scheme)) return "";
  return url.replace(/[\s()<>[\]]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/** Text as one line: whitespace runs become one space (a single character class, no backtracking). */
function collapseWhitespace(text        )         {
  return text.replace(/[ \t\n\r\f]+/gu, " ");
}

// Shortened attribute values: a link or image keeps what the model needs to follow or name it.
const MARKDOWN_MAX_URL = 2_000;
const MARKDOWN_MAX_ALT = 300;
// Nesting markers are capped: indentation or quote prefixes repeated per line must not grow with
// thousands of nested lists or quotes.
const MARKDOWN_MAX_LIST_INDENT = 8;
const MARKDOWN_MAX_QUOTE_PREFIX = 4;
const HEADINGS                                   = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
const MARKDOWN_BLOCKS = new Set([
  "address", "article", "aside", "details", "div", "dl", "fieldset", "figcaption", "figure",
  "footer", "form", "header", "main", "nav", "p", "section", "summary", "table",
]);
const STRONG = new Set(["b", "strong"]);
const EMPHASIS = new Set(["cite", "dfn", "em", "i"]);
// The model sees at most 50 KB of Markdown; the conversion stops well past that.
export const MARKDOWN_MAX_OUTPUT_CHARACTERS = 500_000;

/** Output with a count of trailing line breaks, so blocks are separated without re-reading it. */
class MarkdownWriter {
                   parts           = [];
  length = 0;
          trailingNewlines = 0;

  get empty()          {
    return this.length === 0;
  }

  get atLineStart()          {
    return this.empty || this.trailingNewlines > 0;
  }

  write(text        )       {
    if (text === "") return;
    this.parts.push(text);
    this.length += text.length;
    let index = text.length;
    while (index > 0 && text.charCodeAt(index - 1) === 0x0a) index -= 1;
    this.trailingNewlines = index === 0 ? this.trailingNewlines + text.length : text.length - index;
  }

  /** Ends the current line and leaves `count` line breaks (2 for a paragraph break). */
  breakLines(count        )       {
    if (this.empty) return;
    if (this.trailingNewlines < count) this.write("\n".repeat(count - this.trailingNewlines));
  }

  /** Everything written since `mark`, taken out of the output. */
  takeSince(mark        )         {
    const taken = this.parts.splice(mark).join("");
    this.length -= taken.length;
    const rest = this.parts.at(-1) ?? "";
    let index = rest.length;
    while (index > 0 && rest.charCodeAt(index - 1) === 0x0a) index -= 1;
    this.trailingNewlines = rest.length - index;
    return taken;
  }

  get mark()         {
    return this.parts.length;
  }

  result()         {
    // Line ends lose their trailing spaces one line at a time (native trimEnd, no regular
    // expression over the whole text), and paragraph breaks are at most one empty line.
    return this.parts.join("").split("\n").map((line) => line.trimEnd()).join("\n")
      .replace(/\n{3,}/gu, "\n\n").trim();
  }
}

export function htmlToMarkdown(
  html        ,
  maxOutputCharacters         = MARKDOWN_MAX_OUTPUT_CHARACTERS,
)                                           {
  const out = new MarkdownWriter();
  const lists                                             = [];
  let quoteDepth = 0;
  let preDepth = 0;
  let link                                        = null;
  let cellIndex = 0;
  const linePrefix = () => "> ".repeat(Math.min(quoteDepth, MARKDOWN_MAX_QUOTE_PREFIX));
  const block = () => {
    out.breakLines(2);
  };
  let truncated = false;
  for (const token of tokens(html, MARKDOWN_SKIPPED_ELEMENTS)) {
    if (out.length > maxOutputCharacters) {
      truncated = true;
      break;
    }
    if (token.kind === "skip") {
      // A dropped script or comment still separates the words around it.
      if (!out.atLineStart && preDepth === 0) out.write(" ");
      continue;
    }
    if (token.kind === "text") {
      const decoded = token.cdata ? token.text : decodeHtmlEntities(token.text);
      if (preDepth > 0) {
        out.write(decoded);
        continue;
      }
      let text = collapseWhitespace(decoded);
      if (out.atLineStart) text = text.trimStart();
      if (text === "") continue;
      if (out.atLineStart) out.write(linePrefix());
      out.write(text);
      continue;
    }
    const { closing, name } = token;
    const heading = HEADINGS[name];
    if (heading !== undefined) {
      block();
      if (!closing) out.write(`${linePrefix()}${"#".repeat(heading)} `);
    } else if (MARKDOWN_BLOCKS.has(name)) {
      block();
    } else if (name === "blockquote") {
      quoteDepth = Math.max(0, quoteDepth + (closing ? -1 : 1));
      block();
    } else if (name === "ul" || name === "ol") {
      if (closing) lists.pop();
      else lists.push({ count: 0, ordered: name === "ol" });
      if (lists.length === 0) block();
      else out.breakLines(1);
    } else if (name === "li" && !closing) {
      out.breakLines(1);
      const list = lists.at(-1);
      const marker = list?.ordered ? `${(list.count += 1)}. ` : "- ";
      out.write(`${linePrefix()}${"  ".repeat(Math.min(Math.max(0, lists.length - 1), MARKDOWN_MAX_LIST_INDENT))}${marker}`);
    } else if (name === "br") {
      out.write("\n");
    } else if (name === "hr") {
      block();
      out.write("---");
      block();
    } else if (name === "pre") {
      if (!closing) {
        block();
        out.write("```\n");
        preDepth += 1;
      } else if (preDepth > 0) {
        preDepth -= 1;
        out.breakLines(1);
        out.write("```");
        block();
      }
    } else if (name === "code" && preDepth === 0) {
      out.write("`");
    } else if (STRONG.has(name) && preDepth === 0) {
      out.write("**");
    } else if (EMPHASIS.has(name) && preDepth === 0) {
      out.write("*");
    } else if (name === "a") {
      // Links do not nest: an inner start tag is ignored, so taking a link's text is linear.
      if (!closing && link === null) {
        link = { href: markdownUrl(attribute(token.raw, "href")), mark: out.mark };
      } else if (closing && link !== null) {
        const text = collapseWhitespace(out.takeSince(link.mark)).trim();
        if (link.href !== "" && text !== "") out.write(`[${text}](${link.href})`);
        else out.write(text);
        link = null;
      }
    } else if (name === "img" && !closing) {
      const src = markdownUrl(attribute(token.raw, "src"));
      const alt = collapseWhitespace(decodeHtmlEntities(attribute(token.raw, "alt") ?? "")).trim().slice(0, MARKDOWN_MAX_ALT);
      if (src !== "") out.write(`![${alt}](${src})`);
      else if (alt !== "") out.write(alt);
    } else if (name === "tr") {
      out.breakLines(1);
      cellIndex = 0;
    } else if (name === "td" || name === "th") {
      if (!closing && cellIndex > 0) out.write(" | ");
      if (!closing) cellIndex += 1;
    } else if (!INLINE_ELEMENTS.has(name) && !STRONG.has(name) && !EMPHASIS.has(name) && preDepth === 0) {
      // An unknown element separates words as a browser's block would; inline ones join them.
      if (!out.atLineStart) out.write(" ");
    }
  }
  return { markdown: out.result(), truncated };
}
