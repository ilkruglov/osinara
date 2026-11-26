/**
 * Telegram-to-workspace attachment ingestion tests.
 *
 * Constructs covered:
 * - `createTelegramWorkspaceAttachmentImporter`: validated persistence before model dispatch.
 * - Deterministic personal/family/group inbox references, binary persistence, and count limits.
 */
import type { TelegramAttachment } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import type { WorkspaceFileRecord } from "../workspaces/workspace-file-record.js";
import { createTelegramWorkspaceAttachmentImporter } from "./telegram-workspace-attachments.js";

const auth = {
  familyId: "00000000-0000-4000-8000-000000000001",
  groupId: null,
  groupType: null,
  role: "owner" as const,
  telegramChatType: "private" as const,
  userId: "00000000-0000-4000-8000-000000000002",
};

const attachment: TelegramAttachment = {
  fileId: "telegram-file-id",
  fileName: "Семейный бюджет.csv",
  fileUniqueId: "unique-file-id",
  kind: "document",
  mediaType: "text/csv",
  size: 20,
};

// The lookups of earlier messages' files; the persist pipeline never calls them.
const UNUSED_LOOKUPS = {
  findBinaryWritesByKeyPrefixes: vi.fn(),
  listFilesUnder: vi.fn(),
};

describe("createTelegramWorkspaceAttachmentImporter", () => {
  const record = (path: string, mediaType = "image/jpeg"): WorkspaceFileRecord => ({
    byteSize: 1,
    contentSha256: "0".repeat(64),
    mediaType,
    path,
    scope: "personal",
    updatedAt: "2026-11-25T23:27:01.000Z",
  });

  it("finds the files earlier messages stored and the workspace still holds", async () => {
    const files: Record<string, WorkspaceFileRecord[]> = {
      "telegram-attachment:telegram-101:11:": [record("inbox/11/photo-a.jpg")],
      "telegram-attachment:telegram-101:12:": [record("inbox/12/photo-b.jpg")],
    };
    const findBinaryWritesByKeyPrefixes = vi.fn(
      async (_auth: unknown, _scope: unknown, prefixes: readonly string[]) =>
        prefixes.map((prefix) => files[prefix] ?? []),
    );
    // The second message's file was removed from the workspace after it was stored.
    const listFilesUnder = vi.fn(async (_auth: unknown, _scope: unknown, directory: string) =>
      directory === "inbox/11"
        ? [{ path: "inbox/11/photo-a.jpg", updatedAt: new Date("2026-11-25T23:27:01.000Z") }]
        : [],
    );
    const importer = createTelegramWorkspaceAttachmentImporter({
      download: vi.fn(),
      findBinaryWritesByKeyPrefixes,
      listFilesUnder,
      writeBinary: vi.fn(),
    });

    const stored = await importer.stored({
      auth,
      chatId: "telegram-101",
      messageIds: ["11", "12", "13"],
      scope: "personal",
    });

    expect(stored).toEqual([
      {
        mediaType: "image/jpeg",
        path: "inbox/11/photo-a.jpg",
        scope: "personal",
        telegramMessageId: "11",
      },
    ]);
    // One lookup for all three; a message that stored nothing (a text) is not listed.
    expect(findBinaryWritesByKeyPrefixes.mock.calls.map((call) => call[2])).toEqual([
      [
        "telegram-attachment:telegram-101:11:",
        "telegram-attachment:telegram-101:12:",
        "telegram-attachment:telegram-101:13:",
      ],
    ]);
    expect(listFilesUnder.mock.calls.map((call) => call[2])).toEqual(["inbox/11", "inbox/12"]);
  });

  // Review, 26 November 2026: the inbox is shared with the sandbox. A file rewritten in place is not
  // the Telegram attachment any more, and a directory that cannot be read must not fail the turn.
  it("skips a file rewritten after it was stored and a directory it cannot read", async () => {
    const importer = createTelegramWorkspaceAttachmentImporter({
      download: vi.fn(),
      findBinaryWritesByKeyPrefixes: vi.fn(
        async (_auth: unknown, _scope: unknown, prefixes: readonly string[]) =>
          prefixes.map((prefix) => [
            record(prefix.endsWith(":21:") ? "inbox/21/a.png" : "inbox/22/b.png", "image/png"),
          ]),
      ),
      listFilesUnder: vi.fn(async (_auth: unknown, _scope: unknown, directory: string) => {
        if (directory === "inbox/22") {
          throw new AppError(
            "AGENT_WORKSPACE_SYMLINK_FORBIDDEN",
            "Символические ссылки запрещены в workspace",
          );
        }
        return [{ path: "inbox/21/a.png", updatedAt: new Date("2026-11-26T08:00:00.000Z") }];
      }),
      writeBinary: vi.fn(),
    });

    await expect(
      importer.stored({
        auth,
        chatId: "telegram-101",
        messageIds: ["21", "22"],
        scope: "personal",
      }),
    ).resolves.toEqual([]);
  });

  it("validates and persists an authorized private attachment in personal inbox", async () => {
    const bytes = Buffer.from("name,value\nчай,2\n", "utf8");
    const writeBinary = vi.fn().mockResolvedValue({
      byteSize: bytes.byteLength,
      contentSha256: "a".repeat(64),
      id: "file-1",
      mediaType: "text/csv",
      path: "inbox/42/Семейный бюджет.csv",
      scope: "personal",
      updatedAt: "2026-07-12T00:00:00.000Z",
    });
    const importer = createTelegramWorkspaceAttachmentImporter({
      ...UNUSED_LOOKUPS,
      download: vi.fn().mockResolvedValue(bytes),
      writeBinary,
    });

    const result = await importer.persist({
      attachments: [attachment],
      auth,
      chatId: "101",
      messageId: "42",
      scope: "personal",
    });

    expect(result).toMatchObject([
      {
        mediaType: "text/csv",
        path: "inbox/42/Семейный бюджет.csv",
        scope: "personal",
        telegramMessageId: "42",
      },
    ]);
    expect(writeBinary).toHaveBeenCalledWith(auth, {
      bytes,
      mediaType: "text/csv",
      operationKey: "telegram-attachment:101:42:unique-file-id",
      path: "inbox/42/Семейный бюджет.csv",
      scope: "personal",
    });
  });

  it("rejects an impossible multi-attachment message before downloading", async () => {
    const download = vi.fn();
    const importer = createTelegramWorkspaceAttachmentImporter({
      ...UNUSED_LOOKUPS,
      download,
      writeBinary: vi.fn(),
    });

    await expect(
      importer.persist({
        attachments: [attachment, { ...attachment, fileId: "second" }],
        auth,
        chatId: "101",
        messageId: "42",
        scope: "personal",
      }),
    ).rejects.toThrowError(/AGENT_ATTACHMENT_COUNT_EXCEEDED/);
    expect(download).not.toHaveBeenCalled();
  });

  it("persists an unnamed opaque document under a stable Telegram-derived name", async () => {
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    const writeBinary = vi.fn().mockResolvedValue({
      byteSize: bytes.byteLength,
      contentSha256: "b".repeat(64),
      id: "file-opaque",
      mediaType: "application/octet-stream",
      path: "inbox/43/document-opaque-id",
      scope: "personal",
      updatedAt: "2026-07-13T00:00:00.000Z",
    });
    const importer = createTelegramWorkspaceAttachmentImporter({
      ...UNUSED_LOOKUPS,
      download: vi.fn().mockResolvedValue(bytes),
      writeBinary,
    });

    await expect(
      importer.persist({
        attachments: [
          {
            fileId: "opaque-file-id",
            fileUniqueId: "opaque-id",
            kind: "document",
            mediaType: "application/octet-stream",
          },
        ],
        auth,
        chatId: "101",
        messageId: "43",
        scope: "personal",
      }),
    ).resolves.toEqual([
      {
        mediaType: "application/octet-stream",
        path: "inbox/43/document-opaque-id",
        scope: "personal",
        telegramMessageId: "43",
      },
    ]);
    expect(writeBinary).toHaveBeenCalledWith(
      auth,
      expect.objectContaining({
        mediaType: "application/octet-stream",
        path: "inbox/43/document-opaque-id",
      }),
    );
  });

  it("isolates a family attachment by its trusted Telegram group", async () => {
    const bytes = Buffer.from("family file", "utf8");
    const familyAuth = {
      ...auth,
      groupId: "00000000-0000-4000-8000-000000000123",
      groupType: "family_private" as const,
      telegramChatType: "group" as const,
    };
    const writeBinary = vi.fn().mockResolvedValue({
      byteSize: bytes.byteLength,
      contentSha256: "c".repeat(64),
      mediaType: "application/octet-stream",
      path: "inbox/groups/00000000-0000-4000-8000-000000000123/44/archive.custom",
      scope: "family",
      updatedAt: "2026-07-13T00:00:00.000Z",
    });
    const importer = createTelegramWorkspaceAttachmentImporter({
      ...UNUSED_LOOKUPS,
      download: vi.fn().mockResolvedValue(bytes),
      writeBinary,
    });

    await importer.persist({
      attachments: [{ ...attachment, fileName: "archive.custom" }],
      auth: familyAuth,
      chatId: "-100123",
      messageId: "44",
      scope: "family",
    });

    expect(writeBinary).toHaveBeenCalledWith(
      familyAuth,
      expect.objectContaining({
        path: "inbox/groups/00000000-0000-4000-8000-000000000123/44/archive.custom",
        scope: "family",
      }),
    );
  });

  it("persists only readable UTF-8 text in an external group workspace inbox", async () => {
    const bytes = Buffer.from("# Group notes\n\nDecision: ship safely.\n", "utf8");
    const groupAuth = {
      ...auth,
      groupId: "00000000-0000-4000-8000-000000000456",
      groupType: "external" as const,
      role: "external" as const,
      telegramChatType: "supergroup" as const,
      userId: null,
    };
    const writeBinary = vi.fn().mockResolvedValue({
      byteSize: bytes.byteLength,
      contentSha256: "d".repeat(64),
      mediaType: "text/markdown",
      path: "inbox/45/notes.md",
      scope: "group",
      updatedAt: "2026-08-03T00:00:00.000Z",
    });
    const importer = createTelegramWorkspaceAttachmentImporter({
      ...UNUSED_LOOKUPS,
      download: vi.fn().mockResolvedValue(bytes),
      writeBinary,
    });

    await importer.persist({
      attachments: [
        {
          fileId: "text-file",
          fileName: "notes.md",
          fileUniqueId: "text-id",
          kind: "document",
          mediaType: "text/markdown",
        },
      ],
      auth: groupAuth,
      chatId: "-100456",
      messageId: "45",
      scope: "group",
    });

    expect(writeBinary).toHaveBeenCalledWith(
      groupAuth,
      expect.objectContaining({
        mediaType: "text/markdown",
        path: "inbox/45/notes.md",
        scope: "group",
      }),
    );
  });

  it("rejects binary bytes disguised as external text before persistence", async () => {
    const writeBinary = vi.fn();
    const groupAuth = {
      ...auth,
      groupId: "00000000-0000-4000-8000-000000000456",
      groupType: "external" as const,
      role: "external" as const,
      telegramChatType: "supergroup" as const,
      userId: null,
    };
    const importer = createTelegramWorkspaceAttachmentImporter({
      ...UNUSED_LOOKUPS,
      download: vi.fn().mockResolvedValue(Buffer.from([0x00, 0xff, 0x01])),
      writeBinary,
    });

    await expect(
      importer.persist({
        attachments: [
          {
            fileId: "binary-file",
            fileName: "notes.txt",
            kind: "document",
            mediaType: "text/plain",
          },
        ],
        auth: groupAuth,
        chatId: "-100456",
        messageId: "46",
        scope: "group",
      }),
    ).rejects.toThrowError(/AGENT_ATTACHMENT_TEXT_REQUIRED/u);
    expect(writeBinary).not.toHaveBeenCalled();
  });
});
