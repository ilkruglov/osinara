/**
 * Telegram channel events of a whisper turn.
 *
 * Constructs covered:
 * - `message.completed` of a whisper goes only to its placeholder: no chat delivery, no journal
 *   entry, no delivered-message routes, no memory reinforcement.
 * - `input.requested` is refused: a confirmation or a question would show in the chat.
 * - `turn.failed` tells the failure in the placeholder and never posts to the group.
 * - `turn.started` of a whisper moves no group timeline cursor.
 * - `turn.completed` lets the placeholder say so when the turn showed nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  advanceCursor: vi.fn(),
  bindMemoryTurnSources: vi.fn(),
  bindEveSession: vi.fn(),
  channelConfig: null as Record<string, any> | null,
  clearApprovals: vi.fn(),
  deliverFinalOutput: vi.fn(),
  deliverWhisper: vi.fn(),
  finishWhisper: vi.fn(),
  handleInputRequested: vi.fn(),
  postStableMessage: vi.fn(),
  recordAgentResponse: vi.fn(),
  recordTurnFailed: vi.fn(),
  registerRoutes: vi.fn(),
  reinforce: vi.fn(),
  releaseMemoryTurnSources: vi.fn(),
  reportWhisperFailure: vi.fn(),
}));

vi.mock("eve/channels/telegram", () => ({
  telegramChannel: (config: Record<string, any>) => {
    dependencies.channelConfig = config;
    return config;
  },
}));
vi.mock("./whisper/telegram-whisper-delivery.js", () => ({
  deliverTelegramWhisperCompletion: dependencies.deliverWhisper,
  finishTelegramWhisperTurn: dependencies.finishWhisper,
  reportTelegramWhisperFailure: dependencies.reportWhisperFailure,
}));
vi.mock("./sessions/session-context.js", () => ({
  applicationSessionId: vi.fn(() => "application-session-1"),
  registerTelegramDeliveredMessageRoutes: dependencies.registerRoutes,
}));
vi.mock("./sessions/session-repository.js", () => ({
  sessionRepository: {
    bindEveSession: dependencies.bindEveSession,
    hasPendingOperation: vi.fn(async () => false),
    isCurrentEveSession: vi.fn(async () => true),
    recordTurnCompleted: vi.fn(async () => "recorded"),
    recordTurnFailed: dependencies.recordTurnFailed,
  },
}));
vi.mock("./sessions/group-timeline-cursor-repository.js", () => ({
  groupTimelineCursorRepository: { advance: dependencies.advanceCursor },
}));
vi.mock("./telegram-final-delivery.js", () => ({ deliverTelegramFinalOutput: dependencies.deliverFinalOutput }));
vi.mock("./telegram-final-delivery-repository.js", () => ({
  telegramFinalDeliveryRepository: { shouldSuppressFailureMessage: vi.fn(async () => false) },
}));
vi.mock("./telegram-hitl/approval-repository.js", () => ({
  telegramHitlApprovalRepository: { clearForEveSession: dependencies.clearApprovals },
}));
vi.mock("./telegram-hitl/input-request.js", () => ({ handleTelegramInputRequested: dependencies.handleInputRequested }));
vi.mock("./telegram-stable-delivery.js", () => ({
  postTelegramMessageWithoutContinuationChange: dependencies.postStableMessage,
}));
vi.mock("./telegram-group-journal-repository.js", () => ({
  telegramGroupJournalRepository: { recordAgentResponse: dependencies.recordAgentResponse },
}));
vi.mock("./memory-turn-source.js", () => ({
  bindMemoryTurnSources: dependencies.bindMemoryTurnSources,
  releaseMemoryTurnSources: dependencies.releaseMemoryTurnSources,
}));
vi.mock("./memory-used-reinforcement.js", () => ({ reinforceUsedMemories: dependencies.reinforce }));
vi.mock("./memory-review/memory-review-repository.js", () => ({
  memoryReviewRepository: { batchIdForTurn: vi.fn(async () => null) },
}));
vi.mock("./telegram-reaction-policy.js", () => ({ refreshTelegramReactionPolicy: vi.fn() }));

await import("../channels/telegram.js");

const whisperContext = {
  session: {
    auth: {
      current: {
        attributes: {
          applicationSessionId: "application-session-1",
          groupId: "group-1",
          telegramChatId: "-1001",
          telegramChatType: "supergroup",
          telegramConversationId: "conversation-1",
          telegramWhisper: "true",
          telegramWhisperPlaceholderId: "31",
          telegramWhisperReceiverId: "101",
        },
        authenticator: "telegram",
        principalId: "user-1",
        principalType: "user",
      },
      initiator: null,
    },
    id: "eve-session-1",
    turn: { id: "turn-1", sequence: 1 },
  },
};

const channel = { state: { chatType: "supergroup" }, telegram: { chatId: "-1001" } };

function handler(name: string) {
  const event = dependencies.channelConfig?.events?.[name];
  if (typeof event !== "function") throw new Error(`AGENT_TEST_EVENT_MISSING: ${name}`);
  return event;
}

describe("Telegram channel whisper events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.deliverWhisper.mockResolvedValue(undefined);
    dependencies.reportWhisperFailure.mockResolvedValue(undefined);
  });

  it("delivers a whisper answer only into its placeholder", async () => {
    await handler("message.completed")({ finishReason: "stop", message: "Прав Илья." }, channel, whisperContext);

    expect(dependencies.deliverWhisper).toHaveBeenCalledExactlyOnceWith(
      { finishReason: "stop", message: "Прав Илья." },
      whisperContext.session.auth,
    );
    expect(dependencies.deliverFinalOutput).not.toHaveBeenCalled();
    expect(dependencies.recordAgentResponse).not.toHaveBeenCalled();
    expect(dependencies.registerRoutes).not.toHaveBeenCalled();
    expect(dependencies.reinforce).not.toHaveBeenCalled();
  });

  it("binds no group timeline at the start of a whisper turn", async () => {
    await handler("turn.started")({}, channel, whisperContext);

    expect(dependencies.advanceCursor).not.toHaveBeenCalled();
  });

  it("lets the placeholder say so when the whisper turn showed nothing", async () => {
    await handler("turn.completed")({}, channel, whisperContext);

    expect(dependencies.finishWhisper).toHaveBeenCalledExactlyOnceWith(whisperContext.session.auth);
  });

  it("refuses a confirmation or a question in a whisper", async () => {
    await expect(handler("input.requested")({}, channel, whisperContext))
      .rejects.toMatchObject({ code: "AGENT_TELEGRAM_WHISPER_INPUT_FORBIDDEN" });
    expect(dependencies.handleInputRequested).not.toHaveBeenCalled();
  });

  it("tells a failed whisper turn in the placeholder and posts nothing to the group", async () => {
    await handler("turn.failed")({ code: "MODEL_CALL_FAILED", message: "сбой" }, channel, whisperContext);

    expect(dependencies.reportWhisperFailure).toHaveBeenCalledExactlyOnceWith(
      whisperContext.session.auth,
      expect.any(String),
    );
    expect(dependencies.postStableMessage).not.toHaveBeenCalled();
    expect(dependencies.recordTurnFailed).toHaveBeenCalledOnce();
  });
});
