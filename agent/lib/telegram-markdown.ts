/**
 * Safe Markdown-to-HTML rendering for Telegram file captions.
 *
 * Export:
 * - `renderTelegramMarkdownHtml`: converts the supported caption subset to Telegram HTML, or to
 *   plain text when the tags it made are ones Telegram refuses.
 */
import { placeholderMarker, restorePlaceholders } from "./text-placeholders.js";

const TELEGRAM_MESSAGE_MAX_CHARACTERS = 4_096;
const TELEGRAM_LINK_MAX_CHARACTERS = 2_048;
const REPEATED_EMOJI_MINIMUM = 8;
const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tg:"]);
const WEB_LINK_PROTOCOLS = new Set(["http:", "https:"]);
/** Telegram keeps the first 100 entities of a text and drops the rest, a link's address with it. */
const TELEGRAM_MAX_ENTITIES = 100;
// oxlint-disable-next-line no-control-regex -- the check is for control characters themselves
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function inlineMarker(markdown: string): string {
  const marker = placeholderMarker(markdown);
  if (marker === null) {
    throw new Error(
      "AGENT_TELEGRAM_MARKDOWN_PLACEHOLDER_UNAVAILABLE: Input exhausts reserved markers",
    );
  }
  return marker;
}

/**
 * The escaped address, or null when it stays text. Telegram reads a NUL as the end of the attribute
 * and refuses the caption whole, and drops a link to an http host without a dot (other than IPv6),
 * the address with it (repeat review, 23 November 2026).
 */
function safeLink(rawUrl: string): string | null {
  if (rawUrl.length > TELEGRAM_LINK_MAX_CHARACTERS || CONTROL_CHARACTER.test(rawUrl)) return null;
  if (!URL.canParse(rawUrl)) return null;
  const url = new URL(rawUrl);
  if (!ALLOWED_LINK_PROTOCOLS.has(url.protocol)) return null;
  const host = url.hostname;
  if (WEB_LINK_PROTOCOLS.has(url.protocol) && !host.includes(".") && !host.startsWith("[")) {
    return null;
  }

  // Escaping can expand ampersands enough to make the indivisible opening tag invalid.
  const escaped = escapeHtml(rawUrl);
  if (`<a href="${escaped}"></a>`.length >= TELEGRAM_MESSAGE_MAX_CHARACTERS) return null;
  return escaped;
}

function collapseRepeatedEmoji(value: string): string {
  const repeated = new RegExp(
    `(\\p{Extended_Pictographic}(?:\\uFE0E|\\uFE0F)?)(?:[ \\t]*\\1){${REPEATED_EMOJI_MINIMUM - 1},}`,
    "gu",
  );
  return value.replace(repeated, (match, emoji: string) => {
    const count = match.match(/\p{Extended_Pictographic}/gu)!.length;
    return `${emoji} × ${count}`;
  });
}

function tableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const body = trimmed.replace(/^\|/u, "").replace(/\|$/u, "");
  const cells = body.split("|").map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function isTableSeparator(line: string): boolean {
  const cells = tableCells(line);
  return cells !== null && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function renderInline(markdown: string): string {
  const marker = inlineMarker(markdown);
  const replacements: string[] = [];
  const reserve = (html: string): string => {
    const index = replacements.push(html) - 1;
    return `${marker}${index}${marker}`;
  };

  // Protect code and validated links before escaping and interpreting emphasis markers.
  const code: string[] = [];
  let source = markdown.replace(/`([^`\n]+)`/gu, (_match, text: string) => {
    code.push(text);
    return reserve(`<code>${escapeHtml(text)}</code>`);
  });
  // Every placeholder so far is code, its index that of `code`. Telegram nests no code entity in a
  // link, so a label's code stays literal plain text, and an address's backticks are characters of
  // it, as CommonMark reads them.
  source = source.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/gu, (match, label: string, url: string) => {
    const href = safeLink(restorePlaceholders(url, marker, (index) => `\`${code[index]}\``));
    if (href === null) return match;
    const plain = restorePlaceholders(label, marker, (index) => reserve(escapeHtml(code[index]!)));
    const text = restorePlaceholders(renderInline(plain), marker, (index) => replacements[index]!);
    return reserve(`<a href="${href}">${text}</a>`);
  });
  source = collapseRepeatedEmoji(source);

  let html = escapeHtml(source);
  html = html.replace(/\*\*([^*\n]+)\*\*/gu, "<b>$1</b>");
  html = html.replace(/__([^_\n]+)__/gu, "<b>$1</b>");
  html = html.replace(/~~([^~\n]+)~~/gu, "<s>$1</s>");
  html = html.replace(/(^|[^\p{L}\p{N}])\*([^*\n]+)\*(?=$|[^\p{L}\p{N}])/gu, "$1<i>$2</i>");
  html = html.replace(/(^|[^\p{L}\p{N}])_([^_\n]+)_(?=$|[^\p{L}\p{N}])/gu, "$1<i>$2</i>");

  // Restore only placeholders created by this invocation; raw model HTML remains escaped.
  return restorePlaceholders(html, marker, (index) => replacements[index]!);
}

function isSpecialBlockStart(line: string): boolean {
  return (
    line.startsWith("```") ||
    /^#{1,6}\s+/u.test(line) ||
    /^>\s?/u.test(line) ||
    /^(?:[-+*]|\d+\.)\s+/u.test(line)
  );
}

/** Tags that hold text Telegram shows as is: nothing else goes inside them, nor them inside a link. */
const LITERAL_TAGS = new Set(["code", "pre"]);

/**
 * Whether Telegram takes the rendered tags: every tag closes in order (crossing emphasis is refused
 * whole, «Unmatched end tag»), no code or preformatted text inside a link or a link inside them (the
 * link is dropped), no quotation inside a quotation, at most 100 of them. Only `<pre><code>` nests a
 * literal tag, as the Bot API writes a code block.
 */
function telegramAcceptsTags(html: string): boolean {
  const open: string[] = [];
  let opened = 0;
  for (const [, closing, name] of html.matchAll(/<(\/?)([a-z]+)[^>]*>/gu)) {
    const tag = name!;
    if (closing) {
      if (open.pop() !== tag) return false;
      continue;
    }
    opened += 1;
    if (opened > TELEGRAM_MAX_ENTITIES) return false;
    const inside = open.at(-1);
    if (inside !== undefined && LITERAL_TAGS.has(inside) && !(inside === "pre" && tag === "code")) {
      return false;
    }
    // Nothing opens inside a literal tag (above), so a link or a literal one under a link is the case.
    if ((tag === "a" || LITERAL_TAGS.has(tag)) && open.includes("a")) return false;
    if (tag === "blockquote" && open.includes("blockquote")) return false;
    open.push(tag);
  }
  return open.length === 0;
}

/**
 * The caption as Telegram HTML; a caption whose tags Telegram would refuse or mangle goes as plain
 * text instead, so the file still goes (repeat review, 23 November 2026: `**сумма _1 200** ₽_` made
 * crossing tags, and the delivery failed).
 */
export function renderTelegramMarkdownHtml(markdown: string): string {
  const html = renderMarkdownHtml(markdown);
  return telegramAcceptsTags(html) ? html : escapeHtml(markdown);
}

function renderMarkdownHtml(markdown: string): string {
  const lines = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const blocks: string[] = [];

  // Render block constructs first so inline markers cannot alter Telegram tags.
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/u.test(lines[index]!)) {
        codeLines.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }
    const headerCells = tableCells(line);
    if (headerCells && index + 1 < lines.length && isTableSeparator(lines[index + 1]!)) {
      const rows = [headerCells];
      index += 2;
      while (index < lines.length) {
        const cells = tableCells(lines[index]!);
        if (!cells || isTableSeparator(lines[index]!)) break;
        rows.push(cells);
        index += 1;
      }
      const table = rows.map((cells) => cells.map(collapseRepeatedEmoji).join(" | ")).join("\n");
      blocks.push(`<pre>${escapeHtml(table)}</pre>`);
      continue;
    }
    // A marker with nothing after it is a heading with no text: nothing to show.
    const heading = /^#{1,6}\s+(.*)$/u.exec(line);
    if (heading) {
      const title = heading[1]!.trim();
      if (title.length > 0) blocks.push(`<b>${renderInline(title)}</b>`);
      index += 1;
      continue;
    }
    if (/^>\s?/u.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/u.test(lines[index]!)) {
        quoteLines.push(lines[index]!.replace(/^>\s?/u, ""));
        index += 1;
      }
      blocks.push(`<blockquote>${renderInline(quoteLines.join("\n"))}</blockquote>`);
      continue;
    }
    if (/^(?:[-+*]|\d+\.)\s+/u.test(line)) {
      const listLines: string[] = [];
      while (index < lines.length && /^(?:[-+*]|\d+\.)\s+/u.test(lines[index]!)) {
        const item = lines[index]!;
        const unordered = /^[-+*]\s+(.+)$/u.exec(item);
        listLines.push(unordered ? `• ${renderInline(unordered[1]!)}` : renderInline(item));
        index += 1;
      }
      blocks.push(listLines.join("\n"));
      continue;
    }

    // The first line always goes into the paragraph: a line some branch above did not take but
    // that still reads as a block start (a heading over U+2028, say) looped here forever.
    const paragraph: string[] = [lines[index]!];
    index += 1;
    while (
      index < lines.length &&
      lines[index]!.trim().length > 0 &&
      !isSpecialBlockStart(lines[index]!)
    ) {
      paragraph.push(lines[index]!);
      index += 1;
    }
    blocks.push(renderInline(paragraph.join("\n")));
  }
  return blocks.join("\n\n");
}
