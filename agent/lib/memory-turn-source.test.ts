/**
 * Turn-bound memory source selection tests.
 *
 * Constructs covered:
 * - `resolveMemoryTurnSource`: current source default and visible group-delta sequence selection.
 * - Personal turns reject historical source selection even if a sequence is supplied.
 * - A selected source must remain bound to the same verified caller and memory partition.
 */
import { describe, expect, it, vi } from "vitest";

const { resolve } = vi.hoisted(() => ({ resolve: vi.fn() }));

vi.mock("./memory-turn-source-repository.js", () => ({
  memoryTurnSourceRepository: { resolve },
}));

import type { MemoryAuthorization } from "./memory-context.js";
import { resolveMemoryTurnSource } from "./memory-turn-source.js";

const groupAuthorization: MemoryAuthorization = {
  familyId: "family-1",
  groupId: "group-1",
  role: "external",
  scopes: ["group"],
  telegramUserId: "caller-1",
  userId: null,
};
const context = {
  session: {
    auth: { current: null, initiator: null },
    id: "eve-session-1",
    turn: { id: "eve-turn-1", sequence: 0 },
  },
} as never;

describe("turn-bound memory source selection", () => {
  it("selects a visible group-delta source by rendered sequence", async () => {
    resolve.mockResolvedValueOnce({
      conversationId: "conversation-1",
      invokingTelegramUserId: "caller-1",
      isCurrent: false,
      messageThreadId: null,
      scope: "group",
      scopePartitionKey: "group-1",
      sourceMessageId: "420",
      timelineEntryId: "entry-42",
    });

    await expect(resolveMemoryTurnSource(context, groupAuthorization, "42")).resolves.toEqual({
      conversationId: "conversation-1",
      isCurrent: false,
      messageThreadId: null,
      sourceMessageId: "420",
      timelineEntryId: "entry-42",
    });
    expect(resolve).toHaveBeenCalledWith({
      eveSessionId: "eve-session-1",
      eveTurnId: "eve-turn-1",
      sourceSequence: "42",
    });
  });

  it("rejects sourceSequence in a personal turn before repository access", async () => {
    resolve.mockClear();
    const personal: MemoryAuthorization = {
      ...groupAuthorization,
      groupId: null,
      scopes: ["personal"],
    };

    await expect(resolveMemoryTurnSource(context, personal, "42"))
      .rejects.toMatchObject({ code: "AGENT_MEMORY_EXPLICIT_SOURCE_INVALID" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects a source bound to another invoking Telegram caller", async () => {
    resolve.mockResolvedValueOnce({
      conversationId: "conversation-1",
      invokingTelegramUserId: "caller-2",
      isCurrent: false,
      messageThreadId: null,
      scope: "group",
      scopePartitionKey: "group-1",
      sourceMessageId: "420",
      timelineEntryId: "entry-42",
    });

    await expect(resolveMemoryTurnSource(context, groupAuthorization, "42"))
      .rejects.toMatchObject({ code: "AGENT_MEMORY_EXPLICIT_SOURCE_INVALID" });
  });
});
