/**
 * Telegram reaction update tests.
 *
 * Constructs covered:
 * - A reaction update yields chat, message, person, the new emojis (variation selector dropped,
 *   custom emoji by id) and the time; a removed reaction yields an empty list.
 * - Other updates, an anonymous channel reactor and a malformed update yield null.
 * - The handler records a reaction and answers `ok`; a failed write is logged and still `ok`.
 */
import { describe, expect, it, vi } from "vitest";

import { handleTelegramUnparsedUpdate, parseTelegramReactionUpdate } from "./telegram-reaction-update.js";

const update = {
  message_reaction: {
    chat: { id: -1001787011433, type: "supergroup" },
    date: 1_791_000_000,
    message_id: 807_600,
    new_reaction: [{ emoji: "👍️", type: "emoji" }, { custom_emoji_id: "5368324170671202286", type: "custom_emoji" }],
    old_reaction: [],
    user: { first_name: "Илья", id: 453_059_406, is_bot: false },
  },
  update_id: 85_095_700,
};

describe("parseTelegramReactionUpdate", () => {
  it("reads the reaction and its author", () => {
    expect(parseTelegramReactionUpdate(update)).toEqual({
      changedAt: new Date(1_791_000_000_000),
      emojis: ["👍", "custom:5368324170671202286"],
      telegramChatId: "-1001787011433",
      telegramMessageId: "807600",
      telegramUserId: "453059406",
      updateId: "85095700",
    });
    expect(parseTelegramReactionUpdate({ ...update, message_reaction: { ...update.message_reaction, new_reaction: [] } })?.emojis).toEqual([]);
  });

  it("ignores other updates, anonymous reactors and malformed payloads", () => {
    expect(parseTelegramReactionUpdate({ message: { text: "hi" }, update_id: 1 })).toBeNull();
    const { user: _user, ...anonymous } = update.message_reaction;
    expect(parseTelegramReactionUpdate({ ...update, message_reaction: { ...anonymous, actor_chat: { id: -100 } } })).toBeNull();
    expect(parseTelegramReactionUpdate({ ...update, message_reaction: { ...update.message_reaction, date: "soon" } })).toBeNull();
    expect(parseTelegramReactionUpdate(null)).toBeNull();
    const { update_id: _id, ...noUpdateId } = update;
    expect(parseTelegramReactionUpdate(noUpdateId)).toBeNull();
  });
});

describe("handleTelegramUnparsedUpdate", () => {
  it("records a reaction and always answers ok", async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    expect((await handleTelegramUnparsedUpdate(update, record)).status).toBe(200);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ telegramMessageId: "807600" }));
    expect((await handleTelegramUnparsedUpdate({ update_id: 2 }, record)).status).toBe(200);
    expect(record).toHaveBeenCalledTimes(1);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = vi.fn().mockRejectedValue(new Error("db down"));
    expect((await handleTelegramUnparsedUpdate(update, failing)).status).toBe(200);
    expect(error.mock.calls[0]?.[0]).toContain("AGENT_TELEGRAM_REACTION_RECORD_FAILED");
  });
});
