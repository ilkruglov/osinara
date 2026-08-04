/**
 * Model-facing Telegram group history authorization tests.
 *
 * Constructs covered:
 * - `requireTelegramGroupHistoryAuthorization`: derives group identity only from verified auth.
 * - `searchTelegramGroupHistory`: forwards bounded filters without accepting a model scope.
 * - Date filters fail fast even when this boundary is called without the model schema.
 * - The tool schema and every group mode teach exact, sequential history retrieval.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import listGroupHistory from "./tools/list_group_history.js";
import { AppError } from "./app-error.js";
import { modeInstructions } from "./prompt/mode-instructions.js";
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
  it("teaches exact filter and pagination semantics in the model-facing schema", () => {
    const description = listGroupHistory.description;
    const schema = z.toJSONSchema(
      listGroupHistory.inputSchema as unknown as z.ZodType,
    ) as {
      properties?: Record<string, { description?: string }>;
    };

    expect(description).toContain("не семантический поиск");
    expect(description).toContain("объединяются через AND");
    expect(description).toContain("один вызов на model step");
    expect(description).toContain('{"beforeSequence":"320","limit":3}');
    expect(schema.properties?.query?.description).toContain("буквальная подстрока");
    expect(schema.properties?.participant?.description).toContain("username участника");
    expect(schema.properties?.beforeSequence?.description).toContain("строго меньше");
    expect(schema.properties?.sequenceFrom?.description).toContain("включительно");
    expect(schema.properties?.sequenceTo?.description).toContain("включительно");
    expect(schema.properties?.from?.description).toContain("включительно");
    expect(schema.properties?.to?.description).toContain("включительно");
    expect(schema.properties?.limit?.description).toContain("после применения всех фильтров");
  });

  it.each([
    ["family", modeInstructions({ environment: "family" })],
    [
      "external with granted history",
      modeInstructions({ capabilities: new Set(["list_group_history"]), environment: "external" }),
    ],
  ] as const)("forbids parallel history calls in the %s mode instructions", (_mode, instructions) => {
    expect(instructions).toContain("Не вызывай `list_group_history` параллельно");
    expect(instructions).toContain("дождись результата текущего вызова");
    expect(instructions).toContain("не приписывай результат другому набору фильтров");
  });

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
      groupType: "external",
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
      groupType: "external",
    }))).rejects.toMatchObject({
      code: "AGENT_GROUP_HISTORY_DATE_INVALID",
    });
    expect(repository.search).not.toHaveBeenCalled();
  });
});
