/**
 * Workspace-to-Telegram delivery tests.
 *
 * Constructs covered:
 * - `deliverWorkspaceFile`: explicit photo/document multipart uploads to the current chat/topic.
 * - Transport and unparseable success responses remain ambiguous after delivery begins.
 * - A 429 pauses every call and the upload is tried once more after it (Codex review,
 *   6 November 2026: multipart uploads ignored Telegram's pause).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const pacer = vi.hoisted(() => ({
  acquire: vi.fn(async () => undefined),
  retryAfter: vi.fn(() => true),
  waitForPause: vi.fn(async () => undefined),
}));
vi.mock("eve/channels/telegram", async (importOriginal) => ({
  ...await importOriginal<typeof import("eve/channels/telegram")>(),
  telegramSendPacer: pacer,
}));

import { deliverWorkspaceFile } from "./telegram-workspace-file-delivery.js";

const originalToken = process.env.TELEGRAM_BOT_TOKEN;

afterEach(() => {
  if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalToken;
});

describe("deliverWorkspaceFile", () => {
  it("uploads a file once more after Telegram's pause", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error_code: 429, ok: false, parameters: { retry_after: 2 } }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), { status: 200 }));

    const result = await deliverWorkspaceFile({
      bytes: Buffer.from("file bytes"), chatId: "101", fileName: "notes.txt", mediaType: "text/plain", presentation: "document",
    }, fetchMock);

    expect(result).toEqual({ telegramMessageId: "77" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pacer.retryAfter).toHaveBeenCalledWith(2);
    expect(pacer.waitForPause).toHaveBeenCalled();
  });

  it.each([
    ["photo", "sendPhoto", "photo"],
    ["document", "sendDocument", "document"],
  ] as const)("uploads a %s through Telegram %s", async (presentation, method, field) => {
    process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true, result: { message_id: 77 } }),
      { headers: { "content-type": "application/json" }, status: 200 },
    ));

    const result = await deliverWorkspaceFile({
      bytes: Buffer.from("file bytes"),
      caption: "**Запрошенный файл**",
      chatId: "101",
      fileName: "image.png",
      mediaType: "image/png",
      messageThreadId: 12,
      presentation,
    }, fetchMock);

    expect(result).toEqual({ telegramMessageId: "77" });
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toContain(`/${method}`);
    const form = request.body as FormData;
    expect(form.get("chat_id")).toBe("101");
    expect(form.get("message_thread_id")).toBe("12");
    expect(form.get("caption")).toBe("<b>Запрошенный файл</b>");
    expect(form.get("parse_mode")).toBe("HTML");
    expect(form.get(field)).toBeInstanceOf(Blob);
  });

  it("rejects a non-image photo presentation before contacting Telegram", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
    const fetchMock = vi.fn();

    await expect(deliverWorkspaceFile({
      bytes: Buffer.from("document"),
      chatId: "101",
      fileName: "notes.txt",
      mediaType: "text/plain",
      presentation: "photo",
    }, fetchMock)).rejects.toThrowError(/AGENT_TELEGRAM_PHOTO_TYPE_INVALID/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks a network failure as ambiguous", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:secret-token";

    await expect(deliverWorkspaceFile({
      bytes: Buffer.from("document"),
      chatId: "101",
      fileName: "notes.txt",
      mediaType: "text/plain",
      presentation: "document",
    }, vi.fn().mockRejectedValue(new Error("socket closed"))))
      .rejects.toThrowError(/AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS/);
  });

  it.each([
    ["unparseable", new Response("not-json", { status: 200 })],
    ["missing receipt", new Response(JSON.stringify({ ok: true, result: {} }), {
      headers: { "content-type": "application/json" },
      status: 200,
    })],
  ])("marks a %s success response as ambiguous", async (_case, response) => {
    process.env.TELEGRAM_BOT_TOKEN = "123:test-token";

    await expect(deliverWorkspaceFile({
      bytes: Buffer.from("document"),
      chatId: "101",
      fileName: "notes.txt",
      mediaType: "text/plain",
      presentation: "document",
    }, vi.fn().mockResolvedValue(response)))
      .rejects.toThrowError(/AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS/u);
  });
});
