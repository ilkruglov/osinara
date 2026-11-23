/**
 * Placeholders that keep reserved pieces of a text out of later rewriting.
 *
 * Exports:
 * - `placeholderMarker`: a private-use character the text does not contain, or null when it
 *   contains them all.
 * - `restorePlaceholders`: puts the reserved values back in one pass from the left.
 *
 * Key construct:
 * - A placeholder is the marker, the value's index and the marker again. Replacing one index at a
 *   time, in either order, read the digits between two placeholders as a third one: «`a`1`b`» lost
 *   a code span in captions, «`x`0`y`» in Mia's replies (repeat review, 23 November 2026). Both
 *   Markdown renderers of Telegram text share this.
 */
const PLACEHOLDER_START = 0xe000;
const PLACEHOLDER_END = 0xf8ff;

export function placeholderMarker(text: string): string | null {
  for (let codePoint = PLACEHOLDER_START; codePoint <= PLACEHOLDER_END; codePoint += 1) {
    const marker = String.fromCodePoint(codePoint);
    if (!text.includes(marker)) return marker;
  }
  return null;
}

export function restorePlaceholders(
  text: string,
  marker: string,
  value: (index: number) => string,
): string {
  return text.replace(new RegExp(`${marker}(\\d+)${marker}`, "gu"), (_match, index: string) =>
    value(Number(index)),
  );
}
