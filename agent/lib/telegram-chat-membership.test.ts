/**
 * Telegram chat presence lookup tests.
 *
 * Constructs covered:
 * - Every documented member status maps to presence or absence without guessing.
 * - A restricted member is present only while Telegram still reports membership.
 * - An unusable answer stays unknown and fails closed instead of implying absence.
 * - A missing bot token is reported as configuration, not as a retryable provider failure.
 */
import { describe, expect, it, vi } from "vitest";

import { AppError } from "./app-error.js";

const telegram = vi.hoisted(() => ({ callTelegramApi: vi.fn() }));

vi.mock("eve/channels/telegram", () => ({ callTelegramApi: telegram.callTelegramApi }));

const { telegramChatMemberPresence } = await import("./telegram-chat-membership.js");

const TARGET = { telegramChatId: "-1001", telegramUserId: "77" };

// The lookup resolves the bot token itself, so the suite provides one explicitly instead of
// depending on the ambient environment: the test container has none.
process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";

function answer(result: unknown, overrides: { ok?: boolean; status?: number } = {}) {
  return {
    body: { ok: overrides.ok ?? true, result },
    ok: overrides.ok ?? true,
    status: overrides.status ?? 200,
  };
}

// Every case sets its own transport answer instead of sharing a reset hook: in Vitest 4.1 a shared
// hook that resets this hoisted mock re-surfaces a mock failure as an unhandled test error even
// after the code under test has caught and translated it.
describe("telegramChatMemberPresence", () => {
  it.each(["creator", "administrator", "member"])("reports %s as present", async (status) => {
    telegram.callTelegramApi.mockResolvedValue(answer({ status }));

    await expect(telegramChatMemberPresence(TARGET)).resolves.toBe("present");
    expect(telegram.callTelegramApi).toHaveBeenCalledWith(expect.objectContaining({
      body: { chat_id: "-1001", user_id: 77 },
      method: "getChatMember",
    }));
  });

  it.each(["left", "kicked"])("reports %s as absent", async (status) => {
    telegram.callTelegramApi.mockResolvedValue(answer({ status }));

    await expect(telegramChatMemberPresence(TARGET)).resolves.toBe("absent");
  });

  it.each([
    ["still a member", true, "present"],
    ["no longer a member", false, "absent"],
  ])("reads a restricted member that is %s", async (_case, isMember, expected) => {
    telegram.callTelegramApi.mockResolvedValue(answer({ is_member: isMember, status: "restricted" }));

    await expect(telegramChatMemberPresence(TARGET)).resolves.toBe(expected);
  });

  it.each([
    ["a provider failure", () => answer(null, { ok: false, status: 500 })],
    ["a rejected request", () => answer(null, { ok: false, status: 400 })],
    ["an unknown status", () => answer({ status: "invented" })],
    ["a missing status", () => answer({})],
  ])("fails closed on %s", async (_case, build) => {
    telegram.callTelegramApi.mockResolvedValue(build());

    await expect(telegramChatMemberPresence(TARGET))
      .rejects.toThrowError(/AGENT_TELEGRAM_CHAT_PRESENCE_UNKNOWN/u);
  });

  it("fails closed when the transport itself throws", async () => {
    telegram.callTelegramApi.mockImplementation(() => {
      throw new Error("socket hang up");
    });

    // The transport failure is caught and translated, so it is asserted on the caught value: a
    // rejection matcher would additionally surface the mock's own synchronous throw.
    let caught: unknown = null;
    try {
      await telegramChatMemberPresence(TARGET);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("AGENT_TELEGRAM_CHAT_PRESENCE_UNKNOWN");
  });

  it("fails as configuration when the bot token is missing", async () => {
    telegram.callTelegramApi.mockClear();
    const token = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      await expect(telegramChatMemberPresence(TARGET))
        .rejects.toThrowError(/AGENT_TELEGRAM_PRESENCE_CONFIG_MISSING/u);
    } finally {
      process.env.TELEGRAM_BOT_TOKEN = token;
    }
    expect(telegram.callTelegramApi).not.toHaveBeenCalled();
  });

  it("refuses a Telegram user id that is not a positive integer", async () => {
    telegram.callTelegramApi.mockClear();

    await expect(telegramChatMemberPresence({ ...TARGET, telegramUserId: "seed-1" }))
      .rejects.toThrowError(/AGENT_TELEGRAM_CHAT_PRESENCE_TARGET_INVALID/u);
    expect(telegram.callTelegramApi).not.toHaveBeenCalled();
  });
});
