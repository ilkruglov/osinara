/**
 * Model-facing Telegram group history authorization tests.
 *
 * Constructs covered:
 * - `requireTelegramGroupHistoryAuthorization`: derives group identity only from verified auth.
 * - `searchTelegramGroupHistory`: forwards bounded filters without accepting a model scope.
 * - Date filters fail fast even when this boundary is called without the model schema.
 */
import { describe, expect, it, vi } from "vitest";

import { AppError } from "./app-error.js";
import {
  requireTelegramGroupHistoryAuthorization,
  searchTelegramGroupHistory,
} from "./telegram-group-history.js";

function context(attributes: Record<string, unknown>) {
  return { session: { auth: { current: {
    attributes,
    authenticator: "telegram",
    principalId: "user-1",
    principalType: "user",
  } } } } as never;
}

describe("Telegram group history", () => {
  it("uses the whole current verified family group without exposing a model scope", () => {
    expect(requireTelegramGroupHistoryAuthorization(context({
      groupId: "group-1",
      groupType: "family_private",
      telegramForumTopicId: "77",
    }))).toEqual({ groupId: "group-1" });
  });

  it("fails closed outside a verified Telegram group", () => {
    expect(() => requireTelegramGroupHistoryAuthorization(context({
      telegramChatType: "private",
    }))).toThrowError(AppError);
  });

  it("passes practical bounded filters to the repository", async () => {
    const repository = { search: vi.fn().mockResolvedValue({ entries: [], nextBeforeSequence: null }) };

    await searchTelegramGroupHistory(repository, { query: "ужин", limit: 20 }, context({
      groupId: "group-1",
      groupType: "external_private",
    }));

    expect(repository.search).toHaveBeenCalledWith(expect.objectContaining({
      allTopics: true,
      groupId: "group-1",
      limit: 20,
      messageThreadId: null,
      query: "ужин",
    }));
  });

  it("rejects an invalid date before querying the repository", async () => {
    const repository = { search: vi.fn() };

    await expect(searchTelegramGroupHistory(repository, { from: "not-a-date" }, context({
      groupId: "group-1",
      groupType: "external_private",
    }))).rejects.toMatchObject({
      code: "AGENT_GROUP_HISTORY_DATE_INVALID",
    });
    expect(repository.search).not.toHaveBeenCalled();
  });
});
