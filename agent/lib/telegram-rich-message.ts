/**
 * Plain text of a Bot API rich message.
 *
 * Exports:
 * - `richMessagePlainText`: flattens `rich_message.blocks` of a raw Telegram message into text.
 * - `withRichMessageText`: fills an inbound update's empty `text` from its rich blocks.
 * - `richMessagePhoto`: the one photo a rich message carries, in Telegram's `photo` size shape.
 * - `normalizeRichMessage`: text from blocks plus that photo lifted into `raw.photo` and one Eve
 *   attachment, so the media gate and the vision path see a channel post like an ordinary photo.
 * - `RICH_TEXT_ONLY_MARKER_KEY`: the ingress marks a post whose photo the external group may not
 *   read; the text still reaches the chat, the photo is never lifted again.
 *
 * Key constructs:
 * - Bot API 10.1 (June 2026) delivers rich messages in `message.rich_message`; `message.text` is
 *   absent or holds only a plain fallback. Eve 0.40.0 parses `text` and `caption` alone, so a
 *   collapsed "Полный ответ" from another bot arrived as an empty message. Block order is kept;
 *   a details block contributes its summary and its nested blocks; rich text given as parts
 *   (strings and link entities) is joined.
 */
import type { TelegramUpdate } from "eve/channels/telegram";
import { asRecord as record } from "./json-value.js";

type JsonRecord = Record<string, unknown>;

/**
 * RichText arrives as a string, as `{ text, entities }`, or as an array of parts: plain strings
 * mixed with typed entities such as `{ type: "url", text, url }`. Only the readable text matters,
 * so parts are joined in order; an array that was ignored here dropped every paragraph with a link.
 */
function richText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(richText).join("");
  const text = record(value)?.text;
  return typeof text === "string" || Array.isArray(text) ? richText(text) : "";
}

function blocksText(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((block) => blockText(record(block)));
}

function blockText(block: JsonRecord | null): string[] {
  if (!block) return [];
  switch (block.type) {
    case "paragraph":
    case "section_heading":
    case "preformatted":
    case "footer":
    case "thinking":
    case "mathematical_expression": {
      const text = richText(block.text);
      return text ? [text] : [];
    }
    case "details": {
      const summary = richText(block.summary ?? block.header);
      return [...(summary ? [summary] : []), ...blocksText(block.blocks)];
    }
    case "block_quotation":
    case "expandable_block_quotation":
      return blocksText(block.blocks);
    case "pull_quotation": {
      const text = richText(block.text);
      return [...(text ? [text] : []), ...blocksText(block.blocks)];
    }
    case "list":
      return Array.isArray(block.items)
        ? block.items.flatMap((item) => {
          const entry = record(item);
          const text = richText(entry?.text);
          return text ? [text] : blocksText(entry?.blocks);
        })
        : [];
    case "table":
      return Array.isArray(block.rows)
        ? block.rows.flatMap((row) => {
          const cells = record(row)?.cells;
          return Array.isArray(cells)
            ? [cells.map((cell) => richText(record(cell)?.text ?? cell)).filter(Boolean).join(" | ")]
            : [];
        }).filter(Boolean)
        : [];
    case "animation":
    case "audio":
    case "photo":
    case "video":
    case "voice_note":
    case "document": {
      const caption = richText(record(block.caption)?.text ?? block.caption);
      return caption ? [caption] : [];
    }
    default:
      return [];
  }
}

export function richMessagePlainText(raw: JsonRecord): string | null {
  const rich = record(raw.rich_message);
  if (!rich) return null;
  const fromBlocks = blocksText(rich.blocks).map((part) => part.trim()).filter(Boolean).join("\n\n");
  if (fromBlocks) return fromBlocks;
  return typeof rich.text === "string" && rich.text.trim() ? rich.text.trim() : null;
}

export function withRichMessageText(update: TelegramUpdate): TelegramUpdate {
  if (update.kind !== "message" || update.message.text.trim()) return update;
  const text = richMessagePlainText(update.message.raw);
  return text === null ? update : { ...update, message: { ...update.message, text } };
}

export const RICH_TEXT_ONLY_MARKER_KEY = "osinara_rich_text_only";
const RICH_MEDIA_BLOCKS = new Set(["animation", "audio", "document", "photo", "video", "voice_note"]);

/** The photo sizes of a rich message that embeds exactly one photo and no other file. */
export function richMessagePhoto(raw: JsonRecord): JsonRecord[] | null {
  const blocks = record(raw.rich_message)?.blocks;
  if (!Array.isArray(blocks)) return null;
  const media = blocks.map(record).filter((block) => block !== null && typeof block.type === "string" && RICH_MEDIA_BLOCKS.has(block.type));
  if (media.length !== 1 || media[0]!.type !== "photo" || !Array.isArray(media[0]!.photo)) return null;
  const sizes = media[0]!.photo.map(record);
  if (sizes.length === 0 || sizes.some((size) => size === null || typeof size.file_id !== "string" || size.file_id.length === 0)) return null;
  return sizes as JsonRecord[];
}

function largestSize(sizes: readonly JsonRecord[]): JsonRecord {
  const area = (size: JsonRecord) => (typeof size.width === "number" ? size.width : 0) * (typeof size.height === "number" ? size.height : 0);
  return sizes.reduce((best, size) => (area(size) > area(best) ? size : best), sizes[0]!);
}

/**
 * A channel post forwarded into a discussion group (23 October 2026, «Дизраптим») is one photo
 * block and paragraphs; Eve parses neither. The photo becomes what an ordinary photo message is,
 * so the external media gate and the vision path decide about it with their usual rules, and the
 * text stands on its own whatever that decision is.
 */
export function normalizeRichMessage(update: TelegramUpdate): TelegramUpdate {
  const withText = withRichMessageText(update);
  if (withText.kind !== "message") return withText;
  const raw = withText.message.raw;
  if (raw[RICH_TEXT_ONLY_MARKER_KEY] === true || raw.photo !== undefined || withText.message.attachments.length > 0) return withText;
  const sizes = richMessagePhoto(raw);
  if (sizes === null) return withText;
  const best = largestSize(sizes);
  return {
    ...withText,
    message: {
      ...withText.message,
      attachments: [{
        fileId: best.file_id as string,
        ...(typeof best.file_unique_id === "string" ? { fileUniqueId: best.file_unique_id } : {}),
        ...(typeof best.height === "number" ? { height: best.height } : {}),
        kind: "photo",
        mediaType: "image/jpeg",
        ...(typeof best.file_size === "number" ? { size: best.file_size } : {}),
        ...(typeof best.width === "number" ? { width: best.width } : {}),
      }],
      raw: { ...raw, photo: sizes },
    },
  };
}

/** Removes the ingress's own mark from a payload or raw message; only the ingress sets it. */
export function withoutRichTextOnlyMarker<T extends JsonRecord>(raw: T): T {
  const message = record(raw.message);
  if (message !== null && RICH_TEXT_ONLY_MARKER_KEY in message) {
    const { [RICH_TEXT_ONLY_MARKER_KEY]: _mark, ...rest } = message;
    return { ...raw, message: rest };
  }
  if (RICH_TEXT_ONLY_MARKER_KEY in raw) {
    const { [RICH_TEXT_ONLY_MARKER_KEY]: _mark, ...rest } = raw;
    return rest as T;
  }
  return raw;
}

/** True when `raw.photo` is exactly the photo lifted out of the rich blocks. */
export function richPhotoIsLifted(raw: JsonRecord): boolean {
  const lifted = richMessagePhoto(raw);
  if (lifted === null || !Array.isArray(raw.photo)) return false;
  const ids = (list: readonly unknown[]) => list.map((size) => record(size)?.file_id).filter((id): id is string => typeof id === "string").sort().join("\u0000");
  return ids(lifted) === ids(raw.photo);
}
