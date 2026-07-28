/**
 * Telegram application session re-keying tests.
 *
 * Constructs covered:
 * - `rekeyTelegramSession`: restores a verified forum topic when Eve channel state omits it.
 */
import { describe, expect, it, vi } from "vitest";

const registerRoute = vi.hoisted(() => vi.fn());

vi.mock("./session-repository.js", () => ({
  sessionRepository: { registerRoute },
}));

import { rekeyTelegramSession } from "./session-context.js";

describe("rekeyTelegramSession", () => {
  it("registers the outgoing bot anchor in the verified forum topic", async () => {
    registerRoute.mockResolvedValue("-1001:278:279");
    const setContinuationToken = vi.fn();
    const channel = {
      setContinuationToken,
      state: {
        chatId: "-1001",
        chatType: "supergroup",
        conversationId: "279",
        messageThreadId: null,
      },
    };
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "session-1",
              telegramMessageThreadId: "278",
            },
          },
        },
      },
    };

    await rekeyTelegramSession(channel as never, ctx as never);

    expect(registerRoute).toHaveBeenCalledWith("session-1", "-1001:278:279");
    expect(setContinuationToken).toHaveBeenCalledWith("-1001:278:279");
  });
});
