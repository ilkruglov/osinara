/**
 * `send_widget`: a workspace HTML file sent as a Telegram widget.
 *
 * Constructs covered:
 * - A checked card goes out with its caption to the current chat and topic, the delivery row is
 *   completed, a group journal entry and a reply route are recorded, and the result carries the
 *   caption note, the sizes, the links and the warnings.
 * - A card that would break (lint error, size over the limit, not HTML) is refused before Telegram
 *   with a correction, and its delivery row is failed so the call is not replayed as a send.
 * - Telegram's refusal is a definite failure; a thrown request is an unknown outcome and the row
 *   stays started, so a retry reports ambiguity instead of a second card.
 * - The same bytes already sent in this turn point at the first message.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  recordAgentResponse: vi.fn(),
  registerTelegramMessageRoutes: vi.fn(),
  send: vi.fn(),
}));

vi.mock("../workspaces/workspace-file-delivery-repository.js", () => ({
  workspaceFileDeliveryRepository: {
    begin: mocks.begin,
    complete: mocks.complete,
    fail: mocks.fail,
  },
}));
vi.mock("../telegram-group-journal-repository.js", () => ({
  telegramGroupJournalRepository: { recordAgentResponse: mocks.recordAgentResponse },
}));
vi.mock("../sessions/session-context.js", () => ({
  applicationSessionId: () => "app-session-1",
  registerTelegramMessageRoutes: mocks.registerTelegramMessageRoutes,
}));
vi.mock("./telegram-widget-send.js", () => ({ sendTelegramWidget: mocks.send }));

import sendWidget from "../tools/send_widget.js";

function context(groupType: "family_private" | "external" = "family_private"): ToolContext {
  const caller = {
    attributes: {
      applicationSessionId: "app-session-1",
      familyId: "family-1",
      groupId: "group-1",
      groupType,
      role: "member",
      telegramChatId: "-1001",
      telegramChatType: "supergroup",
      telegramForumTopicId: "42",
      telegramMessageThreadId: "42",
      telegramTimelineEntryId: "00000000-0000-4000-8000-000000000010",
    },
    authenticator: "telegram",
    principalId: "user-1",
    principalType: "user" as const,
  };
  return {
    callId: "call-1",
    session: {
      auth: { current: caller, initiator: caller },
      id: "eve-session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
  } as unknown as ToolContext;
}

const card = `<style>.c{display:flex;gap:8px}</style><div class="c"><b>Ккал</b> 1 840</div><a href="https://example.com/r">рецепт</a>`;
function reserved(html: string, path = "health/day.html", mediaType = "text/html") {
  return {
    bytes: Buffer.from(html, "utf8"),
    file: { contentSha256: "sha", mediaType, path, scope: "family", size: html.length },
    status: "reserved",
    workspaceId: "workspace-1",
  };
}
const execute = (input: Record<string, unknown>, ctx = context()) =>
  (
    sendWidget as unknown as {
      execute: (input: unknown, ctx: ToolContext) => Promise<Record<string, unknown>>;
    }
  ).execute(input, ctx);

describe("send_widget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.begin.mockResolvedValue(reserved(card));
    mocks.send.mockResolvedValue({ messageId: "777", ok: true });
    mocks.recordAgentResponse.mockResolvedValue({ entryId: "entry-1", sequenceId: "20" });
  });

  it("sends a checked card with its caption, completes the row and records it in the chat journal", async () => {
    const result = await execute({
      caption: "Итог дня: 1 840 ккал",
      path: "health/day.html",
      scope: "family",
    });

    expect(mocks.begin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operationKey: "call-1", presentation: "widget" }),
    );
    expect(mocks.send).toHaveBeenCalledWith({
      caption: "Итог дня: 1 840 ккал",
      chatId: "-1001",
      html: card,
      messageThreadId: "42",
    });
    expect(mocks.complete).toHaveBeenCalledWith("call-1", "777");
    expect(mocks.recordAgentResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        contentText: "[виджет] Итог дня: 1 840 ккал",
        groupId: "group-1",
        messageThreadId: "42",
        telegramMessageIds: ["777"],
      }),
    );
    expect(mocks.registerTelegramMessageRoutes).toHaveBeenCalledWith(
      expect.objectContaining({ messageIds: ["777"] }),
    );
    expect(result).toMatchObject({
      alreadySent: false,
      delivered: true,
      links: ["https://example.com/r"],
      telegramMessageId: "777",
      warnings: [],
    });
    expect(String(result.caption_already_sent)).toMatch(/виджетом/u);
    expect(result.size).toMatchObject({ bytes: Buffer.byteLength(card) });
  });

  it("never advises silence in a scheduled run, which only its final text completes", async () => {
    const scheduled = context();
    (scheduled.session.auth.current!.attributes as Record<string, unknown>).scheduledRunId =
      "run-1";

    const result = await execute(
      { caption: "Погода на сегодня", path: "health/day.html", scope: "family" },
      scheduled,
    );

    expect(String(result.caption_already_sent)).not.toContain("<telegram-silent>");
    expect(String(result.caption_already_sent)).toMatch(/итог/iu);
  });

  it("refuses a card that would break, an oversized one and a file that is not HTML, before Telegram", async () => {
    mocks.begin.mockResolvedValueOnce(reserved(`<img src="https://example.com/a.png">`));
    await expect(execute({ caption: "x", path: "a.html", scope: "family" })).rejects.toThrow(
      /AGENT_TELEGRAM_WIDGET_INVALID/u,
    );
    let seed = 7;
    const noisy = Array.from({ length: 12_000 }, () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return String.fromCharCode(0x41 + ((seed >> 16) % 26));
    }).join("");
    mocks.begin.mockResolvedValueOnce(reserved(`<p>${noisy}</p>`));
    await expect(execute({ caption: "x", path: "a.html", scope: "family" })).rejects.toThrow(
      /AGENT_TELEGRAM_WIDGET_TOO_LARGE/u,
    );
    mocks.begin.mockResolvedValueOnce(reserved("<p>x</p>", "notes.txt", "text/plain"));
    await expect(execute({ caption: "x", path: "notes.txt", scope: "family" })).rejects.toThrow(
      /AGENT_TELEGRAM_WIDGET_NOT_HTML/u,
    );
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.fail).toHaveBeenCalledTimes(3);
  });

  it("refuses any link in an external group", async () => {
    await expect(
      execute({ caption: "x", path: "a.html", scope: "group" }, context("external")),
    ).rejects.toThrow(/ссылки в виджете запрещены/u);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("fails the row on Telegram's refusal and leaves it started when the outcome is unknown", async () => {
    mocks.send.mockResolvedValueOnce({
      ambiguous: false,
      body: { description: "Bad Request: INPUT_MEDIA_WIDGET_HTML_INVALID" },
      ok: false,
      status: 400,
    });
    await expect(execute({ caption: "x", path: "a.html", scope: "family" })).rejects.toThrow(
      /INPUT_MEDIA_WIDGET_HTML_INVALID/u,
    );
    expect(mocks.fail).toHaveBeenCalledWith("call-1", "AGENT_TELEGRAM_WIDGET_REJECTED");
    mocks.fail.mockClear();
    mocks.send.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    await expect(execute({ caption: "x", path: "a.html", scope: "family" })).rejects.toThrow(
      /AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS/u,
    );
    expect(mocks.fail).not.toHaveBeenCalled();
    // A server error or a success without the message id may have delivered it too.
    mocks.send.mockResolvedValueOnce({
      ambiguous: true,
      body: { description: "Bad Gateway" },
      ok: false,
      status: 502,
    });
    await expect(execute({ caption: "x", path: "a.html", scope: "family" })).rejects.toThrow(
      /AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS/u,
    );
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  // Codex review of 1.8.55: a crash after the delivery was recorded but before the chat journal
  // left the card out of the group's history; the replay of that step writes it, like a file does.
  it("writes the chat journal and routes again when a confirmed delivery step replays", async () => {
    mocks.begin.mockResolvedValueOnce({
      ...reserved(card),
      status: "completed",
      telegramMessageId: "777",
    });

    const result = await execute({
      caption: "Итог дня: 1 840 ккал",
      path: "health/day.html",
      scope: "family",
    });

    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.recordAgentResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        contentText: "[виджет] Итог дня: 1 840 ккал",
        telegramMessageIds: ["777"],
      }),
    );
    expect(mocks.registerTelegramMessageRoutes).toHaveBeenCalledWith(
      expect.objectContaining({ messageIds: ["777"] }),
    );
    expect(result).toMatchObject({ delivered: true, replayed: true, telegramMessageId: "777" });
  });

  it("points at the first message when the same bytes already went out in this turn", async () => {
    mocks.begin.mockResolvedValueOnce({
      ...reserved(card),
      status: "duplicate",
      telegramMessageId: "700",
    });
    await expect(
      execute({ caption: "x", path: "health/day.html", scope: "family" }),
    ).resolves.toMatchObject({ alreadySent: true, telegramMessageId: "700" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
