import { htmlToMarkdown } from "./osinara-html-markdown.js";
import { htmlToText } from "./osinara-html-text.js";
function convertHtmlToMarkdown(t) {
  return convertHtmlToMarkdownBounded(t).markdown;
}
// Osinara: turndown built a DOM of the page, recursed over it and trimmed whitespace with
// regular expressions that restart at every space; three Codex reviews (5 October 2026) kept
// finding pages that blocked the event loop for seconds or overflowed its stack. The Markdown now
// comes from one linear pass over the page, cut at an output budget; `truncated` tells the tool
// when it was cut.
function convertHtmlToMarkdownBounded(t) {
  return htmlToMarkdown(t);
}
// Osinara: one linear pass instead of tag-stripping regular expressions that restart at every
// `<` (a page of `<` without `>` blocked the event loop; security review, 5 October 2026).
function extractTextFromHtml(e) {
  return htmlToText(e);
}
export { convertHtmlToMarkdown, convertHtmlToMarkdownBounded, extractTextFromHtml };
