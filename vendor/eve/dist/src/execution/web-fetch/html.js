import TurndownService from "#compiled/turndown/index.js";
import { boundHtmlForMarkdown, htmlToText } from "./osinara-html-text.js";
function convertHtmlToMarkdown(t) {
  let n = new TurndownService({
    bulletListMarker: `-`,
    codeBlockStyle: `fenced`,
    emDelimiter: `*`,
    headingStyle: `atx`,
    hr: `---`,
  });
  // Osinara: the converter builds a DOM of every element; the page reaches it without scripts,
  // styles and SVG and cut to a tag budget, so adversarial markup cannot block the event loop.
  return (n.remove([`script`, `style`, `meta`, `link`]), n.turndown(boundHtmlForMarkdown(t)));
}
// Osinara: one linear pass instead of tag-stripping regular expressions that restart at every
// `<` (a page of `<` without `>` blocked the event loop; security review, 5 October 2026).
function extractTextFromHtml(e) {
  return htmlToText(e);
}
export { convertHtmlToMarkdown, extractTextFromHtml };
