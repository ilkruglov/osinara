/**
 * Telegram widget limits and sending.
 *
 * Constructs covered:
 * - A widget is measured the way Telegram measures it: UTF-8 bytes of the HTML and the zlib
 *   stream at level 9; over 32 KB or 4 KB compressed it is refused before any request.
 * - `sendTelegramWidget` calls the beta Bot API (`sendWidget`) with the HTML, the caption, the
 *   topic and no bot requests from the widget, and returns the message id or Telegram's refusal.
 */
import { describe, expect, it, vi } from "vitest";

import { measureTelegramWidget, requireTelegramWidgetSize, TELEGRAM_WIDGET_MAX_BYTES } from "./telegram-widget-limits.js";
import { editTelegramWidgetData, sendTelegramWidget, TELEGRAM_WIDGET_API_BASE_URL } from "./telegram-widget-send.js";

const html = "<div style=\"padding:8px\">Привет</div>";

describe("telegram widget limits", () => {
  it("measures UTF-8 bytes and the level-9 zlib stream", () => {
    const size = measureTelegramWidget(html);
    expect(size.bytes).toBe(Buffer.byteLength(html, "utf8"));
    expect(size.compressedBytes).toBeGreaterThan(0);
    expect(requireTelegramWidgetSize(html)).toEqual(size);
  });

  it("refuses a widget over 32 KB or over 4 KB compressed, naming both sizes", () => {
    const tooLong = `<p>${"а".repeat(TELEGRAM_WIDGET_MAX_BYTES)}</p>`;
    expect(() => requireTelegramWidgetSize(tooLong)).toThrow(/AGENT_TELEGRAM_WIDGET_TOO_LARGE/u);
    // Random text barely compresses: under 32 KB raw, far over 4 KB compressed.
    let seed = 7;
    const noisy = Array.from({ length: 12_000 }, () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return String.fromCharCode(0x41 + (seed >> 16) % 26);
    }).join("");
    expect(() => requireTelegramWidgetSize(`<p>${noisy}</p>`)).toThrow(/после сжатия/u);
  });
});

describe("sendTelegramWidget", () => {
  it("sends through the beta Bot API and returns the message id", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`${TELEGRAM_WIDGET_API_BASE_URL}/bot1:test/sendWidget`);
      expect(JSON.parse(String(init?.body))).toEqual({
        allow_queries: false, caption: "Сводка", chat_id: "104638772", height: 0, html, is_shared: false, message_thread_id: 5, width: 0,
      });
      return Response.json({ ok: true, result: { message_id: 6177, widget: {} } });
    });

    await expect(sendTelegramWidget({ botToken: "1:test", caption: "Сводка", chatId: "104638772", fetch, html, messageThreadId: "5" }))
      .resolves.toEqual({ messageId: "6177", ok: true });
  });

  it("returns Telegram's refusal for the caller to classify, and checks the size before any request", async () => {
    const fetch = vi.fn(async () => Response.json({ description: "Forbidden: bot was blocked by the user", error_code: 403, ok: false }, { status: 403 }));
    await expect(sendTelegramWidget({ botToken: "1:test", chatId: "1", fetch, html }))
      .resolves.toEqual({ ambiguous: false, body: { description: "Forbidden: bot was blocked by the user", error_code: 403, ok: false }, ok: false, status: 403 });
    await expect(sendTelegramWidget({ botToken: "1:test", chatId: "1", fetch, html: `<p>${"я".repeat(40_000)}</p>` }))
      .rejects.toThrow(/AGENT_TELEGRAM_WIDGET_TOO_LARGE/u);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("sendTelegramWidget outcome", () => {
  // Codex review of 1.8.55: an answer that neither refuses nor names the message may have sent it.
  it.each([
    ["a success without a message id", 200, { ok: true, result: {} }],
    ["a server error", 502, { description: "Bad Gateway", error_code: 502, ok: false }],
  ])("calls %s ambiguous, never a refusal", async (_name, status, body) => {
    const fetch = vi.fn(async () => Response.json(body, { status }));
    await expect(sendTelegramWidget({ botToken: "1:test", chatId: "1", fetch, html }))
      .resolves.toMatchObject({ ambiguous: true, ok: false, status });
  });
});

describe("editTelegramWidgetData", () => {
  it("writes the per-message state through the beta Bot API and takes an unchanged state as done", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`${TELEGRAM_WIDGET_API_BASE_URL}/bot1:test/editMessageWidgetData`);
      expect(JSON.parse(String(init?.body))).toEqual({ chat_data: "{\"s\":\"driving\"}", chat_id: "101", message_id: 6184 });
      return Response.json({ ok: true, result: true });
    });
    await expect(editTelegramWidgetData({ botToken: "1:test", chatData: "{\"s\":\"driving\"}", chatId: "101", fetch, messageId: "6184" }))
      .resolves.toEqual({ ok: true });
    const unchanged = vi.fn(async () => Response.json({ description: "Bad Request: message is not modified", error_code: 400, ok: false }, { status: 400 }));
    await expect(editTelegramWidgetData({ botToken: "1:test", chatData: "{}", chatId: "101", fetch: unchanged, messageId: "1" })).resolves.toEqual({ ok: true });
    const refused = vi.fn(async () => Response.json({ description: "Bad Request: message to edit not found", error_code: 400, ok: false }, { status: 400 }));
    await expect(editTelegramWidgetData({ botToken: "1:test", chatData: "{}", chatId: "101", fetch: refused, messageId: "1" }))
      .resolves.toMatchObject({ ok: false, status: 400 });
  });
});
