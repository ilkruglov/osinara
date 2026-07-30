/**
 * Workspace file tool Telegram projection tests.
 *
 * Constructs covered:
 * - A confirmed group file delivery is projected into the timeline with session ownership.
 * - The exact Telegram media message receives a reply continuation route.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  complete: vi.fn(),
  deliver: vi.fn(),
  fail: vi.fn(),
  recordAgentResponse: vi.fn(),
  registerTelegramMessageRoutes: vi.fn(),
}));

vi.mock("./attachments/telegram-workspace-file-delivery.js", () => ({
  deliverWorkspaceFile: mocks.deliver,
}));
vi.mock("./workspaces/workspace-file-delivery-repository.js", () => ({
  workspaceFileDeliveryRepository: {
    begin: mocks.begin,
    complete: mocks.complete,
    fail: mocks.fail,
  },
}));
vi.mock("./telegram-group-journal-repository.js", () => ({
  telegramGroupJournalRepository: { recordAgentResponse: mocks.recordAgentResponse },
}));
vi.mock("./sessions/session-context.js", () => ({
  applicationSessionId: () => "app-session-1",
  registerTelegramMessageRoutes: mocks.registerTelegramMessageRoutes,
}));

import sendWorkspaceFile from "../tools/send_workspace_file.js";

function context(): ToolContext {
  const caller = {
    attributes: {
      applicationSessionId: "app-session-1",
      familyId: "family-1",
      groupId: "group-1",
      groupType: "family_private",
      role: "member",
      telegramChatId: "-1001",
      telegramChatType: "supergroup",
      telegramForumTopicId: "42",
      telegramMessageThreadId: "42",
      telegramTimelineEntryId: "00000000-0000-4000-8000-000000000010",
    },
    authenticator: "telegram",
    principalId: "user-1",
    principalType: "user" as const,
  };
  return {
    callId: "call-1",
    session: {
      auth: { current: caller, initiator: caller },
      id: "eve-session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
  } as unknown as ToolContext;
}

describe("send_workspace_file group projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.begin.mockResolvedValue({
      bytes: Buffer.from("image"),
      file: {
        contentSha256: "sha256",
        mediaType: "image/png",
        path: "screens/facade.png",
        scope: "family",
        size: 5,
      },
      status: "reserved",
      workspaceId: "workspace-1",
    });
    mocks.deliver.mockResolvedValue({ telegramMessageId: "446" });
    mocks.recordAgentResponse.mockResolvedValue({ entryId: "entry-1", sequenceId: "20" });
  });

  it("records and routes a confirmed tool-delivered photo", async () => {
    await sendWorkspaceFile.execute({
      caption: "Фасад ресторана",
      path: "screens/facade.png",
      presentation: "photo",
      scope: "family",
    }, context());

    expect(mocks.complete).toHaveBeenCalledWith("call-1", "446");
    expect(mocks.recordAgentResponse).toHaveBeenCalledWith(expect.objectContaining({
      applicationSessionId: "app-session-1",
      attachment: expect.objectContaining({ fileName: "facade.png", kind: "photo" }),
      contentText: "Фасад ресторана",
      groupId: "group-1",
      messageThreadId: "42",
      telegramMessageIds: ["446"],
    }));
    expect(mocks.registerTelegramMessageRoutes).toHaveBeenCalledWith({
      applicationSessionId: "app-session-1",
      chatId: "-1001",
      messageIds: ["446"],
      messageThreadId: 42,
    });
  });

  it("repairs timeline and route projection when a confirmed delivery step replays", async () => {
    mocks.begin.mockResolvedValue({
      bytes: Buffer.from("image"),
      file: {
        contentSha256: "sha256",
        mediaType: "image/png",
        path: "screens/facade.png",
        scope: "family",
        size: 5,
      },
      status: "completed",
      telegramMessageId: "446",
      workspaceId: "workspace-1",
    });

    await expect(sendWorkspaceFile.execute({
      caption: "Фасад ресторана",
      path: "screens/facade.png",
      presentation: "photo",
      scope: "family",
    }, context())).resolves.toMatchObject({ delivered: true, replayed: true });

    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.recordAgentResponse).toHaveBeenCalled();
    expect(mocks.registerTelegramMessageRoutes).toHaveBeenCalled();
  });
});
