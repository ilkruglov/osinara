/**
 * fetch_telegram_avatars tests.
 *
 * Constructs covered:
 * - A participant is resolved by Telegram id, username or name within the current conversation
 *   only; an unknown handle is reported, not guessed, and no conversation means a refusal.
 * - A photo the workspace already holds (same file_unique_id, file still there) is not downloaded
 *   again; a new or changed one is saved as avatars/<id>-<unique>.jpg in the chat's scope under a
 *   key that names the workspace; a removed file is written again under a fresh key.
 * - A concurrent first write loses the key race and takes the winner's record.
 * - No photo, a Telegram failure and a storage failure each get their own reason and leave the
 *   others intact. Several handles for one person are cleaned like the repository does, looked up
 *   one by one from the most exact, and the one that found the person is reported.
 */
import type { ToolContext } from "eve/tools";
import { describe, expect, it, vi } from "vitest";

import { AppError } from "./app-error.js";
import {
  AVATAR_USAGE_NOTE,
  createFetchTelegramAvatarsTool,
} from "./tools/fetch_telegram_avatars.js";

const FILE = {
  byteSize: 12_000,
  contentSha256: "a".repeat(64),
  mediaType: "image/jpeg",
  path: "avatars/5-u5.jpg",
  scope: "group" as const,
  updatedAt: "2026-10-16T12:00:00.000Z",
};

function context(chatType: "private" | "supergroup" = "supergroup"): ToolContext {
  return {
    callId: "call-avatars-1",
    session: {
      auth: {
        current: {
          attributes:
            chatType === "private"
              ? {
                  familyId: "family-1",
                  role: "owner",
                  telegramChatId: "151894754",
                  telegramChatType: "private",
                  telegramConversationId: "conversation-1",
                }
              : {
                  familyId: "family-1",
                  groupId: "group-1",
                  groupType: "external",
                  role: "external",
                  telegramChatId: "-1001",
                  telegramChatType: "supergroup",
                  telegramConversationId: "conversation-1",
                },
          authenticator: "telegram",
          principalId: "telegram:101",
          principalType: "user",
        },
        initiator: null,
      },
      id: "wrun-avatars",
      turn: { id: "turn-avatars", sequence: 1 },
    },
  } as unknown as ToolContext;
}

function dependencies() {
  return {
    participants: {
      findByHandle: vi.fn(
        async (
          _conversationId: string,
          handle: { displayName?: string; telegramUserId?: string; username?: string },
        ) => {
          const base = {
            conversationId: "conversation-1",
            firstObservedAt: "",
            lastObservedAt: "",
            linkedUserId: null,
            participantRef: "part_" + "0".repeat(32),
          };
          if (handle.username?.replace(/^@/u, "") === "vadim_k" || handle.displayName === "Vadim") {
            return {
              ...base,
              displayNameSnapshot: "Vadim",
              id: "p1",
              telegramUserId: "7",
              usernameSnapshot: "vadim_k",
            };
          }
          // Only the people of this conversation resolve, by id as well.
          if (
            handle.telegramUserId !== undefined &&
            ["3", "5", "9"].includes(handle.telegramUserId)
          ) {
            return {
              ...base,
              displayNameSnapshot: `User ${handle.telegramUserId}`,
              id: `p${handle.telegramUserId}`,
              telegramUserId: handle.telegramUserId,
              usernameSnapshot: null,
            };
          }
          return null;
        },
      ),
    },
    source: {
      download: vi.fn().mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
      lookup: vi.fn(async (telegramUserId: string) =>
        telegramUserId === "9"
          ? { status: "none" as const }
          : {
              photo: {
                fileId: `f${telegramUserId}`,
                fileUniqueId: `u${telegramUserId}`,
                height: 640,
                width: 640,
              },
              status: "photo" as const,
            },
      ),
    },
    workspaces: {
      findBinaryWrite: vi.fn().mockResolvedValue(null),
      readBinary: vi.fn().mockResolvedValue({ bytes: Buffer.from("jpeg") }),
      workspaceId: vi.fn().mockResolvedValue("workspace-1"),
      writeBinary: vi.fn(
        async (
          _auth: unknown,
          input: { path: string; scope: "family" | "group" | "personal" },
        ) => ({ ...FILE, path: input.path, scope: input.scope }),
      ),
    },
  };
}

describe("fetch_telegram_avatars", () => {
  it("resolves people by id, username and name, saves new photos and reports the rest", async () => {
    const deps = dependencies();
    const tool = createFetchTelegramAvatarsTool(deps as never);
    const result = await tool.execute(
      {
        participants: [
          { telegramUserId: "5" },
          { username: "@vadim_k" },
          { displayName: "Nobody" },
          { telegramUserId: "9" },
        ],
      },
      context(),
    );
    expect(result).toMatchObject({
      avatars: [
        {
          displayName: "User 5",
          path: "avatars/5-u5.jpg",
          scope: "group",
          status: "saved",
          telegramUserId: "5",
        },
        {
          displayName: "Vadim",
          path: "avatars/7-u7.jpg",
          scope: "group",
          status: "saved",
          telegramUserId: "7",
          username: "vadim_k",
        },
      ],
      missing: [
        { reason: "unknown_participant", requested: "Nobody" },
        { reason: "no_photo_or_private", requested: "9" },
      ],
      scope: "group",
    });
    // The tool cleans "@" as the repository would.
    expect(deps.participants.findByHandle).toHaveBeenCalledWith("conversation-1", {
      username: "vadim_k",
    });
    expect(deps.participants.findByHandle).toHaveBeenCalledWith("conversation-1", {
      telegramUserId: "5",
    });
    expect(deps.workspaces.writeBinary).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        mediaType: "image/jpeg",
        operationKey: "avatar:workspace-1:7:u7",
        path: "avatars/7-u7.jpg",
        scope: "group",
      }),
    );
    expect(deps.source.download).toHaveBeenCalledTimes(2);
    expect((result as { note: string }).note).toBe(AVATAR_USAGE_NOTE);
  });

  it("skips the download for a photo the workspace still holds, and rewrites a removed one under a fresh key", async () => {
    const deps = dependencies();
    deps.workspaces.findBinaryWrite.mockImplementation(
      async (_auth: unknown, _scope: string, key: string) =>
        key === "avatar:workspace-1:5:u5" || key === "avatar:workspace-1:3:u3"
          ? { ...FILE, path: key.includes(":3:") ? "avatars/3-u3.jpg" : FILE.path }
          : null,
    );
    deps.workspaces.readBinary.mockImplementation(
      async (_auth: unknown, _scope: string, path: string) => {
        if (path === "avatars/3-u3.jpg")
          throw new AppError("AGENT_WORKSPACE_FILE_NOT_FOUND", "удалён");
        return { bytes: Buffer.from("jpeg") };
      },
    );
    const tool = createFetchTelegramAvatarsTool(deps as never);
    const result = await tool.execute(
      { participants: [{ telegramUserId: "5" }, { telegramUserId: "3" }] },
      context("private"),
    );
    expect(result).toMatchObject({
      avatars: [
        { path: "avatars/5-u5.jpg", scope: "personal", status: "cached", telegramUserId: "5" },
        { path: "avatars/3-u3.jpg", scope: "personal", status: "saved", telegramUserId: "3" },
      ],
      missing: [],
      scope: "personal",
    });
    expect(deps.source.download).toHaveBeenCalledTimes(1);
    const rewrite = deps.workspaces.writeBinary.mock.calls[0]![1] as unknown as {
      operationKey: string;
    };
    expect(rewrite.operationKey.startsWith("avatar:workspace-1:3:u3:")).toBe(true);
  });

  it("takes the winner's record when a concurrent first write already used the key", async () => {
    const deps = dependencies();
    deps.workspaces.writeBinary.mockRejectedValueOnce(
      new Error("duplicate key value violates unique constraint"),
    );
    deps.workspaces.findBinaryWrite
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...FILE, path: "avatars/5-u5.jpg" });
    const tool = createFetchTelegramAvatarsTool(deps as never);
    const result = await tool.execute({ participants: [{ telegramUserId: "5" }] }, context());
    expect(result).toMatchObject({
      avatars: [{ path: "avatars/5-u5.jpg", status: "saved" }],
      missing: [],
    });
  });

  it("names the stage that failed and keeps going", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const deps = dependencies();
    deps.source.lookup.mockImplementationOnce(async () => {
      throw new AppError("AGENT_TELEGRAM_AVATAR_LOOKUP_FAILED", "HTTP 500");
    });
    deps.workspaces.writeBinary.mockRejectedValueOnce(new Error("disk full"));
    const tool = createFetchTelegramAvatarsTool(deps as never);
    const result = await tool.execute(
      { participants: [{ telegramUserId: "3" }, { telegramUserId: "5" }, { username: "vadim_k" }] },
      context(),
    );
    expect(result).toMatchObject({
      avatars: [{ telegramUserId: "7" }],
      missing: [
        { reason: "telegram_unavailable", requested: "3" },
        { reason: "storage_failed", requested: "5" },
      ],
    });
  });

  it("reaches nobody outside this conversation, by id included, and nothing without a conversation", async () => {
    const deps = dependencies();
    const tool = createFetchTelegramAvatarsTool(deps as never);
    const result = await tool.execute({ participants: [{ telegramUserId: "424242" }] }, context());
    expect(result).toMatchObject({
      avatars: [],
      missing: [{ reason: "unknown_participant", requested: "424242" }],
    });
    expect(deps.source.lookup).not.toHaveBeenCalled();
    const noConversation = context();
    delete (
      noConversation.session.auth.current as unknown as { attributes: Record<string, unknown> }
    ).attributes.telegramConversationId;
    await expect(
      tool.execute({ participants: [{ telegramUserId: "5" }] }, noConversation),
    ).rejects.toMatchObject({ code: "AGENT_TELEGRAM_AVATARS_CONTEXT_INVALID" });
  });

  it("takes up to ten participants in one call", async () => {
    const deps = dependencies();
    const tool = createFetchTelegramAvatarsTool(deps as never);
    const people = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ telegramUserId: String(index + 1) }));
    const result = (await tool.execute({ participants: people(10) }, context())) as {
      avatars: unknown[];
      missing: unknown[];
    };
    // Every one of the ten is looked up, in order, and accounted for: none dropped or repeated.
    expect(
      deps.participants.findByHandle.mock.calls.map(([, handle]) => handle.telegramUserId),
    ).toEqual(people(10).map((person) => person.telegramUserId));
    expect(result.avatars.length + result.missing.length).toBe(10);
    await expect(tool.execute({ participants: people(11) }, context())).rejects.toMatchObject({
      code: "AGENT_TELEGRAM_AVATARS_INPUT_INVALID",
    });
  });

  it("looks a participant up by the most exact handle given, then by the others", async () => {
    // 25 November 2026: the model sent the name and the username together and lost a step on
    // INPUT_INVALID. The repository matches any given field, so each handle is looked up alone:
    // the most exact first, and a miss (a guessed username, a bare "@") falls back to the next.
    const deps = dependencies();
    const tool = createFetchTelegramAvatarsTool(deps as never);
    const result = (await tool.execute(
      {
        participants: [
          { displayName: "Vadim", username: "vadim_k" },
          { displayName: "User 5", telegramUserId: "5", username: "ilya" },
          { displayName: "Vadim", username: "vadim" },
          { displayName: "Vadim", username: "@" },
        ],
      },
      context(),
    )) as { avatars: { telegramUserId: string }[]; missing: unknown[] };
    expect(deps.participants.findByHandle.mock.calls.map(([, handle]) => handle)).toEqual([
      { username: "vadim_k" },
      { telegramUserId: "5" },
      { username: "vadim" },
      { displayName: "Vadim" },
      { displayName: "Vadim" },
    ]);
    expect(result.avatars.map((avatar) => avatar.telegramUserId)).toEqual(["7", "5", "7", "7"]);
    expect(result.missing).toEqual([]);
  });

  it("names the handle that found the person, or the first one given", async () => {
    // A bare "@" is no handle at all; a person found by a later field is reported by that field,
    // so the model can tell who has no photo and who is not in this chat.
    const deps = dependencies();
    deps.source.lookup.mockResolvedValue({ status: "none" });
    const tool = createFetchTelegramAvatarsTool(deps as never);
    const result = (await tool.execute(
      {
        participants: [
          { displayName: "Vadim", username: "@" },
          { displayName: "Vadim", username: "ghost" },
          { displayName: "Nobody", username: "@nobody" },
        ],
      },
      context(),
    )) as { missing: unknown[] };
    expect(deps.participants.findByHandle.mock.calls.map(([, handle]) => handle)).toEqual([
      { displayName: "Vadim" },
      { username: "ghost" },
      { displayName: "Vadim" },
      { username: "nobody" },
      { displayName: "Nobody" },
    ]);
    expect(result.missing).toEqual([
      { reason: "no_photo_or_private", requested: "Vadim" },
      { reason: "no_photo_or_private", requested: "Vadim" },
      { reason: "unknown_participant", requested: "nobody" },
    ]);
  });

  it("requires a handle for every participant", async () => {
    const tool = createFetchTelegramAvatarsTool(dependencies() as never);
    // Fields that are empty once "@" and spaces are gone name nobody, as in the repository.
    for (const participant of [
      {},
      { username: "@" },
      { displayName: "   " },
      { username: " @ " },
    ]) {
      await expect(tool.execute({ participants: [participant] }, context())).rejects.toMatchObject({
        code: "AGENT_TELEGRAM_AVATARS_INPUT_INVALID",
      });
    }
  });
});
