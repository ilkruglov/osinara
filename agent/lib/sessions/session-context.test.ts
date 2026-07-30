/**
 * Telegram application session re-keying tests.
 *
 * Constructs covered:
 * - `rekeyTelegramSession`: restores a verified forum topic when Eve channel state omits it.
 * - Every chunk of a split group response receives a continuation route alias.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const registerRoute = vi.hoisted(() => vi.fn());
const registerRouteAlias = vi.hoisted(() => vi.fn());

vi.mock("./session-repository.js", () => ({
  sessionRepository: { registerRoute, registerRouteAlias },
}));

import { rekeyTelegramSession } from "./session-context.js";

describe("rekeyTelegramSession", () => {
  beforeEach(() => registerRoute.mockReset());

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

  it("registers every delivered chunk before selecting the latest continuation", async () => {
    registerRoute
      .mockResolvedValueOnce("-1001:278:301")
      .mockResolvedValueOnce("-1001:278:302");
    const setContinuationToken = vi.fn();
    const channel = {
      setContinuationToken,
      state: {
        chatId: "-1001",
        chatType: "supergroup",
        conversationId: "302",
        messageThreadId: 278,
      },
    };
    const ctx = {
      session: {
        auth: { current: { attributes: { applicationSessionId: "session-1" } } },
      },
    };

    await rekeyTelegramSession(channel as never, ctx as never, ["301", "302"]);

    expect(registerRoute).toHaveBeenNthCalledWith(1, "session-1", "-1001:278:301");
    expect(registerRoute).toHaveBeenNthCalledWith(2, "session-1", "-1001:278:302");
    expect(setContinuationToken).toHaveBeenCalledWith("-1001:278:302");
  });
});
