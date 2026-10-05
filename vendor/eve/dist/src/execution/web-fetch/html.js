import TurndownService from "#compiled/turndown/index.js";
import { boundHtmlForMarkdown, htmlToText } from "./osinara-html-text.js";
function convertHtmlToMarkdown(t) {
  return convertHtmlToMarkdownBounded(t).markdown;
}
// Osinara: the converter builds a DOM of every element and its output grows quadratically with
// the number of blocks; the page reaches it without scripts, styles and SVG and cut to text, tag
// and depth budgets, and `truncated` tells the tool when the page was cut.
function convertHtmlToMarkdownBounded(t) {
  let { html: b, truncated: c } = boundHtmlForMarkdown(t);
  let n = new TurndownService({
    bulletListMarker: `-`,
    codeBlockStyle: `fenced`,
    emDelimiter: `*`,
    headingStyle: `atx`,
    hr: `---`,
  });
  n.remove([`script`, `style`, `meta`, `link`]);
  try {
    return { markdown: n.turndown(b), truncated: c };
  } catch (e) {
    // Markup the budgets did not foresee can still overflow the converter's recursion: the page
    // goes out as plain text, marked incomplete, instead of failing the tool call.
    if (!(e instanceof RangeError)) throw e;
    return { markdown: htmlToText(b), truncated: !0 };
  }
}
// Osinara: one linear pass instead of tag-stripping regular expressions that restart at every
// `<` (a page of `<` without `>` blocked the event loop; security review, 5 October 2026).
function extractTextFromHtml(e) {
  return htmlToText(e);
}
export { convertHtmlToMarkdown, convertHtmlToMarkdownBounded, extractTextFromHtml };
