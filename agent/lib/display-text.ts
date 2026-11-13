/**
 * Text shown to a person inside a fixed-size Telegram slot.
 *
 * Exports:
 * - `flattenDisplayText`: one line without control or format characters.
 * - `clipText`: at most `limit` characters, ending in «…» when shortened.
 * - `sliceText`: at most `limit` characters, cut without a mark.
 * - `clipMiddleText`: at most `limit` characters, the head and the tail around a count of what
 *   was left out (tool output ends with what matters: the error, the exit code).
 *
 * Key construct:
 * - Approval windows, Gmail previews, lab summaries and error notes each cut text by hand, and only
 *   the settled-prompt copy kept UTF-16 surrogate pairs whole. Telegram rejects a payload with a
 *   split pair, so an emoji at the boundary could fail the whole message. One cut for all of them.
 * - Flattening keeps a model-written value from adding lines or invisible marks that restructure
 *   the message around it.
 */
export function flattenDisplayText(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

export function sliceText(value: string, limit: number): string {
  if (limit <= 0) return "";
  if (value.length <= limit) return value;
  return value.slice(0, isHighSurrogate(value.charCodeAt(limit - 1)) ? limit - 1 : limit);
}

export function clipText(value: string, limit: number): string {
  if (limit <= 0) return "";
  if (value.length <= limit) return value;
  return `${sliceText(value, limit - 1).trimEnd()}…`;
}

const elisionMark = (omitted: number) => ` … [${omitted} chars omitted] … `;

export function clipMiddleText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  // Sized for the largest possible count, so the real mark always fits.
  const kept = limit - elisionMark(value.length).length;
  if (kept <= 0) return sliceText(value, limit);
  const head = sliceText(value, Math.ceil(kept * 0.6));
  let tailStart = value.length - (kept - head.length);
  if (isLowSurrogate(value.charCodeAt(tailStart))) tailStart += 1;
  return `${head}${elisionMark(tailStart - head.length)}${value.slice(tailStart)}`;
}
