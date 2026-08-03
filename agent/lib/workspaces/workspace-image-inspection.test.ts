/**
 * Persistent workspace image inspection tests.
 *
 * Constructs covered:
 * - `createWorkspaceImageInspector`: authorized bytes are sent to vision with the user's question.
 * - Telegram inbox images resolve by stable message ID instead of a model-copied filename.
 * - Opaque journal attachments are downloaded and analyzed without a workspace write.
 * - Non-image and provider-oversized files fail before a paid model call.
 */
import { describe, expect, it, vi } from "vitest";

import { VISION_MAX_FILE_BYTES } from "../../config.js";
import { createWorkspaceImageInspector } from "./workspace-image-inspection.js";

const auth = {
  familyId: "family-1",
  groupId: null,
  groupType: null,
  role: "owner" as const,
  telegramChatType: "private" as const,
  userId: "user-1",
};

describe("createWorkspaceImageInspector", () => {
  it("analyzes an authorized persisted image", async () => {
    const analyze = vi.fn().mockResolvedValue("На изображении семейный календарь.");
    const inspect = createWorkspaceImageInspector({
      analyze,
      readBinary: vi.fn().mockResolvedValue({
        bytes: Buffer.from("image"),
        file: { mediaType: "image/png", path: "photos/calendar.png" },
        workspaceId: "workspace-1",
      }),
      readTelegramInboxAttachment: vi.fn(),
      downloadTelegramAttachment: vi.fn(),
      findTelegramAttachment: vi.fn(),
    });

    await expect(inspect(auth, {
      path: "photos/calendar.png",
      question: "Что изображено?",
      scope: "personal",
    })).resolves.toMatchObject({ analysis: "На изображении семейный календарь." });
    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({
      mediaType: "image/png",
      question: "Что изображено?",
    }));
  });

  it("rejects a document instead of sending unsupported content to the vision model", async () => {
    const analyze = vi.fn();
    const inspect = createWorkspaceImageInspector({
      analyze,
      readBinary: vi.fn().mockResolvedValue({
        bytes: Buffer.from("document"),
        file: { mediaType: "application/pdf", path: "docs/report.pdf" },
        workspaceId: "workspace-1",
      }),
      readTelegramInboxAttachment: vi.fn(),
      downloadTelegramAttachment: vi.fn(),
      findTelegramAttachment: vi.fn(),
    });

    await expect(inspect(auth, {
      path: "docs/report.pdf",
      question: "Что внутри?",
      scope: "personal",
    })).rejects.toThrowError(/AGENT_WORKSPACE_VISION_TYPE_UNSUPPORTED/);
    expect(analyze).not.toHaveBeenCalled();
  });

  it("rejects an image above the native provider limit before a paid call", async () => {
    const analyze = vi.fn();
    const inspect = createWorkspaceImageInspector({
      analyze,
      readBinary: vi.fn().mockResolvedValue({
        bytes: new Uint8Array(VISION_MAX_FILE_BYTES + 1),
        file: { mediaType: "image/png", path: "photos/oversized.png" },
        workspaceId: "workspace-1",
      }),
      readTelegramInboxAttachment: vi.fn(),
      downloadTelegramAttachment: vi.fn(),
      findTelegramAttachment: vi.fn(),
    });

    await expect(inspect(auth, {
      path: "photos/oversized.png",
      question: "Что изображено?",
      scope: "personal",
    })).rejects.toThrowError(/AGENT_WORKSPACE_VISION_FILE_TOO_LARGE/);
    expect(analyze).not.toHaveBeenCalled();
  });

  it("resolves a Telegram image by message ID without copying its untrusted filename", async () => {
    const analyze = vi.fn().mockResolvedValue("На изображении человек.");
    const readTelegramInboxAttachment = vi.fn().mockResolvedValue({
      bytes: Buffer.from("image"),
      file: {
        mediaType: "image/jpeg",
        path: "inbox/773/очень-длинное-имя.jpg",
        scope: "personal",
      },
      workspaceId: "workspace-1",
    });
    const inspect = createWorkspaceImageInspector({
      analyze,
      readBinary: vi.fn(),
      readTelegramInboxAttachment,
      downloadTelegramAttachment: vi.fn(),
      findTelegramAttachment: vi.fn(),
    });

    await expect(inspect(auth, {
      question: "Что изображено?",
      scope: "personal",
      telegramMessageId: "773",
    })).resolves.toMatchObject({
      analysis: "На изображении человек.",
      path: "inbox/773/очень-длинное-имя.jpg",
    });
    expect(readTelegramInboxAttachment).toHaveBeenCalledWith(auth, "personal", "773");
  });

  it("analyzes an opaque Telegram attachment entirely in memory", async () => {
    const analyze = vi.fn().mockResolvedValue("На изображении схема.");
    const downloadTelegramAttachment = vi.fn().mockResolvedValue(
      Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
    );
    const inspect = createWorkspaceImageInspector({
      analyze,
      downloadTelegramAttachment,
      findTelegramAttachment: vi.fn().mockResolvedValue({
        attachment: {
          fileId: "secret-file-id",
          fileName: "scheme.png",
          kind: "document",
          mediaType: "image/png",
          size: 16,
        },
        chatId: "-1001",
        messageId: "41",
      }),
      readBinary: vi.fn(),
      readTelegramInboxAttachment: vi.fn(),
    });

    await expect(inspect({
      ...auth,
      groupId: "group-1",
      groupType: "external",
      role: "external",
      telegramChatType: "supergroup",
      userId: null,
    }, {
      attachmentId: "00000000-0000-4000-8000-000000000041",
      question: "Что изображено?",
      scope: "group",
    })).resolves.toEqual({
      analysis: "На изображении схема.",
      scope: "group",
      source: {
        attachmentId: "00000000-0000-4000-8000-000000000041",
        kind: "document",
        mediaType: "image/png",
        size: 16,
        telegramMessageId: "41",
      },
    });
    expect(downloadTelegramAttachment).toHaveBeenCalledOnce();
    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({ mediaType: "image/png" }));
  });

  it("rejects a disguised image document before a paid vision call", async () => {
    const analyze = vi.fn();
    const inspect = createWorkspaceImageInspector({
      analyze,
      downloadTelegramAttachment: vi.fn().mockResolvedValue(Buffer.from("plain text")),
      findTelegramAttachment: vi.fn().mockResolvedValue({
        attachment: {
          fileId: "secret-file-id",
          fileName: "fake.png",
          kind: "document",
          mediaType: "image/png",
        },
        chatId: "-1001",
        messageId: "41",
      }),
      readBinary: vi.fn(),
      readTelegramInboxAttachment: vi.fn(),
    });

    await expect(inspect({
      ...auth,
      groupId: "group-1",
      groupType: "external",
      role: "external",
      telegramChatType: "supergroup",
      userId: null,
    }, {
      attachmentId: "00000000-0000-4000-8000-000000000041",
      question: "Что изображено?",
      scope: "group",
    })).rejects.toThrowError(/AGENT_WORKSPACE_VISION_TYPE_UNSUPPORTED/);
    expect(analyze).not.toHaveBeenCalled();
  });
});
