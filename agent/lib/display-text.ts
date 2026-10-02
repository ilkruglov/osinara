/**
 * Text shown to a person inside a fixed-size Telegram slot.
 *
 * Exports:
 * - `flattenDisplayText`: one line without control or format characters.
 * - `clipText`: at most `limit` characters, ending in «…» when shortened.
 *
 * Key construct:
 * - Approval windows, Gmail previews, lab summaries and error notes each cut text by hand, and only
 *   the settled-prompt copy kept UTF-16 surrogate pairs whole. Telegram rejects a payload with a
 *   split pair, so an emoji at the boundary could fail the whole message. One cut for all of them.
 * - Flattening keeps a model-written value from adding lines or invisible marks that restructure
 *   the message around it.
 */
export function flattenDisplayText(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
}

export function clipText(value: string, limit: number): string {
  if (limit <= 0) return "";
  if (value.length <= limit) return value;
  let end = limit - 1;
  if (/[\uD800-\uDBFF]/u.test(value[end - 1] ?? "")) end -= 1;
  return `${value.slice(0, end).trimEnd()}…`;
}
