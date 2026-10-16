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
 *   others intact. Input needs exactly one handle per participant.
 */
import type { ToolContext } from "eve/tools";
import { describe, expect, it, vi } from "vitest";

import { AppError } from "./app-error.js";
import { createFetchTelegramAvatarsTool } from "./tools/fetch_telegram_avatars.js";

const FILE = { byteSize: 12_000, contentSha256: "a".repeat(64), mediaType: "image/jpeg", path: "avatars/5-u5.jpg", scope: "group" as const, updatedAt: "2026-10-16T12:00:00.000Z" };

function context(chatType: "private" | "supergroup" = "supergroup"): ToolContext {
  return {
    callId: "call-avatars-1",
    session: {
      auth: {
        current: {
          attributes: chatType === "private"
            ? { familyId: "family-1", role: "owner", telegramChatId: "151894754", telegramChatType: "private", telegramConversationId: "conversation-1" }
            : { familyId: "family-1", groupId: "group-1", groupType: "external", role: "external", telegramChatId: "-1001", telegramChatType: "supergroup", telegramConversationId: "conversation-1" },
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
      findByHandle: vi.fn(async (_conversationId: string, handle: { displayName?: string; telegramUserId?: string; username?: string }) => {
        const base = { conversationId: "conversation-1", firstObservedAt: "", lastObservedAt: "", linkedUserId: null, participantRef: "part_" + "0".repeat(32) };
        if (handle.username?.replace(/^@/u, "") === "vadim_k" || handle.displayName === "Vadim") {
          return { ...base, displayNameSnapshot: "Vadim", id: "p1", telegramUserId: "7", usernameSnapshot: "vadim_k" };
        }
        // Only the people of this conversation resolve, by id as well.
        if (handle.telegramUserId !== undefined && ["3", "5", "9"].includes(handle.telegramUserId)) {
          return { ...base, displayNameSnapshot: `User ${handle.telegramUserId}`, id: `p${handle.telegramUserId}`, telegramUserId: handle.telegramUserId, usernameSnapshot: null };
        }
        return null;
      }),
    },
    source: {
      download: vi.fn().mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
      lookup: vi.fn(async (telegramUserId: string) =>
        telegramUserId === "9" ? { status: "none" as const } : { photo: { fileId: `f${telegramUserId}`, fileUniqueId: `u${telegramUserId}`, height: 640, width: 640 }, status: "photo" as const }),
    },
    workspaces: {
      findBinaryWrite: vi.fn().mockResolvedValue(null),
      readBinary: vi.fn().mockResolvedValue({ bytes: Buffer.from("jpeg") }),
      workspaceId: vi.fn().mockResolvedValue("workspace-1"),
      writeBinary: vi.fn(async (_auth: unknown, input: { path: string; scope: "family" | "group" | "personal" }) => ({ ...FILE, path: input.path, scope: input.scope })),
    },
  };
}

describe("fetch_telegram_avatars", () => {
  it("resolves people by id, username and name, saves new photos and reports the rest", async () => {
    const deps = dependencies();
    const tool = createFetchTelegramAvatarsTool(deps as never);
    const result = await tool.execute({ participants: [{ telegramUserId: "5" }, { username: "@vadim_k" }, { displayName: "Nobody" }, { telegramUserId: "9" }] }, context());
    expect(result).toMatchObject({
      avatars: [
        { displayName: "User 5", path: "avatars/5-u5.jpg", scope: "group", status: "saved", telegramUserId: "5" },
        { displayName: "Vadim", path: "avatars/7-u7.jpg", scope: "group", status: "saved", telegramUserId: "7", username: "vadim_k" },
      ],
      missing: [{ reason: "unknown_participant", requested: "Nobody" }, { reason: "no_photo_or_private", requested: "9" }],
      scope: "group",
    });
    expect(deps.participants.findByHandle).toHaveBeenCalledWith("conversation-1", { username: "@vadim_k" });
    expect(deps.participants.findByHandle).toHaveBeenCalledWith("conversation-1", { telegramUserId: "5" });
    expect(deps.workspaces.writeBinary).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      mediaType: "image/jpeg", operationKey: "avatar:workspace-1:7:u7", path: "avatars/7-u7.jpg", scope: "group",
    }));
    expect(deps.source.download).toHaveBeenCalledTimes(2);
    expect((result as { note: string }).note).toContain("карикатур");
  });

  it("skips the download for a photo the workspace still holds, and rewrites a removed one under a fresh key", async () => {
    const deps = dependencies();
    deps.workspaces.findBinaryWrite.mockImplementation(async (_auth: unknown, _scope: string, key: string) =>
      key === "avatar:workspace-1:5:u5" || key === "avatar:workspace-1:3:u3" ? { ...FILE, path: key.includes(":3:") ? "avatars/3-u3.jpg" : FILE.path } : null);
    deps.workspaces.readBinary.mockImplementation(async (_auth: unknown, _scope: string, path: string) => {
      if (path === "avatars/3-u3.jpg") throw new AppError("AGENT_WORKSPACE_FILE_NOT_FOUND", "удалён");
      return { bytes: Buffer.from("jpeg") };
    });
    const tool = createFetchTelegramAvatarsTool(deps as never);
    const result = await tool.execute({ participants: [{ telegramUserId: "5" }, { telegramUserId: "3" }] }, context("private"));
    expect(result).toMatchObject({
      avatars: [
        { path: "avatars/5-u5.jpg", scope: "personal", status: "cached", telegramUserId: "5" },
        { path: "avatars/3-u3.jpg", scope: "personal", status: "saved", telegramUserId: "3" },
      ],
      missing: [],
      scope: "personal",
    });
    expect(deps.source.download).toHaveBeenCalledTimes(1);
    const rewrite = deps.workspaces.writeBinary.mock.calls[0]![1] as unknown as { operationKey: string };
    expect(rewrite.operationKey.startsWith("avatar:workspace-1:3:u3:")).toBe(true);
  });

  it("takes the winner's record when a concurrent first write already used the key", async () => {
    const deps = dependencies();
    deps.workspaces.writeBinary.mockRejectedValueOnce(new Error("duplicate key value violates unique constraint"));
    deps.workspaces.findBinaryWrite.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...FILE, path: "avatars/5-u5.jpg" });
    const tool = createFetchTelegramAvatarsTool(deps as never);
    const result = await tool.execute({ participants: [{ telegramUserId: "5" }] }, context());
    expect(result).toMatchObject({ avatars: [{ path: "avatars/5-u5.jpg", status: "saved" }], missing: [] });
  });

  it("names the stage that failed and keeps going", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const deps = dependencies();
    deps.source.lookup.mockImplementationOnce(async () => { throw new AppError("AGENT_TELEGRAM_AVATAR_LOOKUP_FAILED", "HTTP 500"); });
    deps.workspaces.writeBinary.mockRejectedValueOnce(new Error("disk full"));
    const tool = createFetchTelegramAvatarsTool(deps as never);
    const result = await tool.execute({ participants: [{ telegramUserId: "3" }, { telegramUserId: "5" }, { username: "vadim_k" }] }, context());
    expect(result).toMatchObject({
      avatars: [{ telegramUserId: "7" }],
      missing: [{ reason: "telegram_unavailable", requested: "3" }, { reason: "storage_failed", requested: "5" }],
    });
  });

  it("reaches nobody outside this conversation, by id included, and nothing without a conversation", async () => {
    const deps = dependencies();
    const tool = createFetchTelegramAvatarsTool(deps as never);
    const result = await tool.execute({ participants: [{ telegramUserId: "424242" }] }, context());
    expect(result).toMatchObject({ avatars: [], missing: [{ reason: "unknown_participant", requested: "424242" }] });
    expect(deps.source.lookup).not.toHaveBeenCalled();
    const noConversation = context();
    delete (noConversation.session.auth.current as unknown as { attributes: Record<string, unknown> }).attributes.telegramConversationId;
    await expect(tool.execute({ participants: [{ telegramUserId: "5" }] }, noConversation)).rejects.toMatchObject({ code: "AGENT_TELEGRAM_AVATARS_CONTEXT_INVALID" });
  });

  it("requires exactly one handle per participant", async () => {
    const tool = createFetchTelegramAvatarsTool(dependencies() as never);
    await expect(tool.execute({ participants: [{ telegramUserId: "5", username: "x" }] }, context())).rejects.toMatchObject({ code: "AGENT_TELEGRAM_AVATARS_INPUT_INVALID" });
    await expect(tool.execute({ participants: [{}] }, context())).rejects.toMatchObject({ code: "AGENT_TELEGRAM_AVATARS_INPUT_INVALID" });
  });
});
