/**
 * Rich message flattening tests.
 *
 * Constructs covered:
 * - A collapsed details block yields its summary and every nested paragraph in order.
 * - Quotations, lists, tables and media captions contribute their text; unknown blocks are skipped.
 * - Rich text given as an array of parts (strings and link entities) is joined, not dropped.
 * - An update with plain text is left untouched; one without rich content stays as it is.
 */
import type { TelegramUpdate } from "eve/channels/telegram";
import { describe, expect, it } from "vitest";

import { normalizeRichMessage, RICH_TEXT_ONLY_MARKER_KEY, richMessagePlainText, withRichMessageText } from "./telegram-rich-message.js";

describe("richMessagePlainText", () => {
  it("unfolds a collapsed details block the way a reader would see it expanded", () => {
    expect(richMessagePlainText({
      rich_message: {
        blocks: [
          { text: "Коротко: не дурак.", type: "paragraph" },
          {
            blocks: [
              { text: "Первый абзац подробностей.", type: "paragraph" },
              { text: "Второй абзац.", type: "paragraph" },
            ],
            summary: "Полный ответ",
            type: "details",
          },
        ],
      },
    })).toBe("Коротко: не дурак.\n\nПолный ответ\n\nПервый абзац подробностей.\n\nВторой абзац.");
  });

  it("reads quotations, lists, tables, captions and rich text objects", () => {
    expect(richMessagePlainText({
      rich_message: {
        blocks: [
          { blocks: [{ text: { entities: [], text: "Цитата." }, type: "paragraph" }], type: "expandable_block_quotation" },
          { items: [{ text: "пункт один" }, { blocks: [{ text: "пункт два", type: "paragraph" }] }], type: "list" },
          { rows: [{ cells: [{ text: "а" }, { text: "б" }] }], type: "table" },
          { caption: { text: "подпись к фото" }, type: "photo" },
          { type: "divider" },
          { type: "unknown_future_block", text: "мимо" },
        ],
      },
    })).toBe("Цитата.\n\nпункт один\n\nпункт два\n\nа | б\n\nподпись к фото");
  });

  it("keeps a paragraph whose rich text is a list of parts with inline links", () => {
    // Bot API RichText may arrive as an array: plain strings mixed with typed entities. A bot that
    // writes file names as links produced paragraphs that vanished whole.
    expect(richMessagePlainText({
      rich_message: {
        blocks: [
          { text: ["Задачи живут в ", { text: "tasks.md", type: "url", url: "tasks.md" }, " в корне."], type: "paragraph" },
          {
            blocks: [{ text: [{ text: "AGENTS.md", type: "url", url: "AGENTS.md" }, " - инструкция."], type: "paragraph" }],
            summary: "Полный ответ",
            type: "details",
          },
        ],
      },
    })).toBe("Задачи живут в tasks.md в корне.\n\nПолный ответ\n\nAGENTS.md - инструкция.");
  });

  it("returns null without rich content and falls back to the plain rich text", () => {
    expect(richMessagePlainText({ text: "обычное" })).toBeNull();
    expect(richMessagePlainText({ rich_message: { blocks: [{ type: "divider" }], text: "запасной" } }))
      .toBe("запасной");
  });
});

describe("withRichMessageText", () => {
  const base = {
    kind: "message",
    message: {
      attachments: [],
      caption: "",
      chat: { id: "-1001", type: "supergroup" },
      messageId: "5",
      raw: { rich_message: { blocks: [{ text: "из блоков", type: "paragraph" }] } },
      text: "",
    },
  } as unknown as TelegramUpdate;

  it("fills an empty text from the blocks and keeps explicit text as is", () => {
    const filled = withRichMessageText(base);
    expect(filled.kind === "message" && filled.message.text).toBe("из блоков");
    const explicit = { ...base, message: { ...(base as { message: object }).message, text: "уже есть" } } as TelegramUpdate;
    expect(withRichMessageText(explicit)).toBe(explicit);
  });
});

// A channel post forwarded into a discussion group (23 October 2026, «Дизраптим»): one photo
// block and paragraphs. Eve parses neither, so the photo must be lifted into the shape the media
// gate and the vision path already understand, and the text must survive on its own.
describe("normalizeRichMessage", () => {
  const sizes = [
    { file_id: "small", file_size: 2_395, file_unique_id: "u-small", height: 89, width: 90 },
    { file_id: "large", file_size: 90_000, file_unique_id: "u-large", height: 1_280, width: 1_280 },
  ];
  const post = {
    kind: "message",
    message: {
      attachments: [],
      caption: "",
      chat: { id: "-1001", type: "supergroup" },
      messageId: "96491",
      raw: { rich_message: { blocks: [{ photo: sizes, type: "photo" }, { text: "пост про эвалы", type: "paragraph" }] } },
      text: "",
    },
  } as unknown as TelegramUpdate;

  it("lifts the single photo block into raw.photo and one photo attachment, and fills the text", () => {
    const normalized = normalizeRichMessage(post);
    if (normalized.kind !== "message") throw new Error("message expected");
    expect(normalized.message.text).toBe("пост про эвалы");
    expect(normalized.message.raw.photo).toEqual(sizes);
    expect(normalized.message.attachments).toEqual([
      { fileId: "large", fileUniqueId: "u-large", height: 1_280, kind: "photo", mediaType: "image/jpeg", size: 90_000, width: 1_280 },
    ]);
  });

  it("keeps the text only when the ingress marked the photo as refused, and lifts nothing else", () => {
    const refused = { ...post, message: { ...(post as { message: object }).message, raw: { ...(post as { message: { raw: object } }).message.raw, [RICH_TEXT_ONLY_MARKER_KEY]: true } } } as unknown as TelegramUpdate;
    const normalized = normalizeRichMessage(refused);
    if (normalized.kind !== "message") throw new Error("message expected");
    expect(normalized.message.text).toBe("пост про эвалы");
    expect(normalized.message.attachments).toEqual([]);
    expect(normalized.message.raw.photo).toBeUndefined();
    const two = { ...post, message: { ...(post as { message: object }).message, raw: { rich_message: { blocks: [{ photo: sizes, type: "photo" }, { photo: sizes, type: "photo" }] } } } } as unknown as TelegramUpdate;
    const twoNormalized = normalizeRichMessage(two);
    expect(twoNormalized.kind === "message" && twoNormalized.message.attachments).toEqual([]);
  });
});
