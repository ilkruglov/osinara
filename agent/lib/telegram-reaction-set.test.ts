/**
 * Telegram reaction set tests.
 *
 * Constructs covered:
 * - Every default reaction passes the same guard the delivery path applies.
 * - `resolveChatReactions`: an unrestricted chat gets the default set, a narrowed chat its own.
 * - A chat with reactions turned off and an unknown policy both resolve to no set at all.
 */
import { describe, expect, it } from "vitest";

import { isTelegramMessageReactionEmoji } from "./telegram-message-reaction.js";
import {
  resolveChatReactions,
  TELEGRAM_DEFAULT_REACTIONS,
} from "./telegram-reaction-set.js";

describe("Telegram reaction set", () => {
  it("keeps every default reaction acceptable to the delivery guard", () => {
    const rejected = TELEGRAM_DEFAULT_REACTIONS.filter(
      (emoji) => !isTelegramMessageReactionEmoji(emoji),
    );

    expect(rejected).toEqual([]);
    expect(new Set(TELEGRAM_DEFAULT_REACTIONS).size).toBe(TELEGRAM_DEFAULT_REACTIONS.length);
  });

  it("gives an unrestricted chat the default set", () => {
    expect(resolveChatReactions({ allowsAll: true, emoji: [] }))
      .toBe(TELEGRAM_DEFAULT_REACTIONS);
  });

  it("gives a narrowed chat exactly its own list", () => {
    expect(resolveChatReactions({ allowsAll: false, emoji: ["👍", "❤️"] }))
      .toEqual(["👍", "❤️"]);
  });

  it.each([
    ["reactions turned off", { allowsAll: false, emoji: [] }],
    ["unknown policy", null],
  ])("resolves %s to no set", (_case, policy) => {
    expect(resolveChatReactions(policy)).toBeNull();
  });
});
