/**
 * Telegram terminal failure notification privacy tests.
 *
 * Constructs covered:
 * - `shouldNotifyTelegramFailure`: permits private chats and fails closed for every shared target.
 * - A spent model call is the one failure a shared chat may learn about.
 */
import { describe, expect, it } from "vitest";

import { shouldNotifyTelegramFailure } from "./telegram-failure-notification.js";

describe("Telegram failure notification privacy", () => {
  it.each([
    ["private", true],
    ["group", false],
    ["supergroup", false],
    ["channel", false],
    [null, false],
  ] as const)("maps chat type %s to notification=%s", (chatType, expected) => {
    expect(shouldNotifyTelegramFailure({ state: { chatType } } as never)).toBe(expected);
  });

  it.each([
    ["group", true],
    ["supergroup", true],
    ["channel", false],
    [null, false],
  ] as const)("tells chat type %s about a spent model call: %s", (chatType, expected) => {
    expect(shouldNotifyTelegramFailure({ state: { chatType } } as never, "MODEL_CALL_FAILED"))
      .toBe(expected);
  });

  it("still hides every other terminal code from a shared chat", () => {
    expect(
      shouldNotifyTelegramFailure({ state: { chatType: "group" } } as never, "AGENT_TOOL_CALL_FAILED"),
    ).toBe(false);
  });
});
