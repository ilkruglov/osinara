/**
 * Agent schedule dispatcher unit tests.
 *
 * Constructs covered:
 * - `createAgentScheduleDispatcher`: prepares isolated Telegram receive target and trusted auth.
 * - A failed claimed job, including failed session cleanup, cannot block the remaining batch.
 */
import { describe, expect, it, vi } from "vitest";

import { createAgentScheduleDispatcher } from "./agent-schedule-dispatcher.js";
import type { ClaimedAgentSchedule } from "./agent-schedule-dispatch-repository.js";

const job: ClaimedAgentSchedule = {
  authorUserId: "user-1",
  capabilityAllowlist: [],
  familyId: "family-1",
  forumTopicId: null,
  groupId: null,
  historyWindowDays: null,
  id: "schedule-1",
  leaseToken: "lease-1",
  messageThreadId: null,
  nextRunAt: "2026-07-17T06:00:00.000Z",
  recurrenceKind: "daily",
  role: "owner",
  runId: "run-1",
  scenarioPrompt: "Собери короткую сводку новостей по ИИ.",
  scope: "personal",
  telegramChatId: "101",
  telegramChatType: "private",
  telegramUserId: "telegram-101",
  timezone: "Europe/Moscow",
  title: "Новости ИИ",
  userRequest: "Каждое утро присылай новости по ИИ",
};

describe("agent schedule dispatcher", () => {
  it("starts a scheduled Telegram session with isolated run auth", async () => {
    const repository = {
      claimDue: vi.fn().mockResolvedValue([job]),
      failClaim: vi.fn(),
      markDispatchStarted: vi.fn(),
      markRunning: vi.fn(),
    };
    const prepareSession = vi.fn().mockResolvedValue({
      continuationToken: "101::schedule:run-1",
      generation: 0,
      id: "app-session-1",
      rotated: false,
      sandboxSessionId: "sandbox-1",
    });
    const receive = vi.fn().mockResolvedValue({
      continuationToken: "101::schedule:run-1",
      getEventStream: vi.fn(),
      id: "eve-session-1",
    });

    const dispatched = await createAgentScheduleDispatcher({
      discardSession: vi.fn(),
      prepareHistory: vi.fn(),
      prepareSession,
      receive,
      repository,
    })(new Date("2026-07-17T06:00:00.000Z"));

    expect(dispatched).toBe(1);
    expect(prepareSession).toHaveBeenCalledWith(
      job,
      "101::schedule:run-1",
      new Date("2026-07-17T06:00:00.000Z"),
    );
    expect(receive).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      auth: expect.objectContaining({
        attributes: expect.objectContaining({
          applicationSessionId: "app-session-1",
          memoryScopes: ["personal", "family"],
          scheduleScheduledFor: "2026-07-17T06:00:00.000Z",
          scheduleTitle: "Новости ИИ",
          scheduledRunId: "run-1",
        }),
        authenticator: "telegram",
        principalId: "user-1",
      }),
      message: expect.stringContaining("<scheduled_agent_run>"),
      target: { chatId: "101", conversationId: "schedule:run-1" },
    }));
    expect(repository.markDispatchStarted).toHaveBeenCalledWith(job, {
      applicationSessionId: "app-session-1",
    });
    expect(repository.markRunning).toHaveBeenCalledWith(job, {
      applicationSessionId: "app-session-1",
      eveSessionId: "eve-session-1",
    });
  });

  it("prepares history before handing an external group run to an isolated external session", async () => {
    const groupJob = {
      ...job,
      capabilityAllowlist: ["send_workspace_file"],
      groupId: "group-1",
      historyWindowDays: 7,
      scope: "group",
      telegramChatId: "-1001234567890",
      telegramChatType: "supergroup",
    } as never;
    const repository = {
      claimDue: vi.fn().mockResolvedValue([groupJob]),
      failClaim: vi.fn(),
      markDispatchStarted: vi.fn(),
      markRunning: vi.fn(),
    };
    const prepareHistory = vi.fn().mockResolvedValue({ chunkCount: 2, entryCount: 75 });
    const prepareSession = vi.fn().mockResolvedValue({
      continuationToken: "-1001234567890::schedule:run-1",
      generation: 0,
      id: "group-session-1",
      rotated: false,
      sandboxSessionId: "group-sandbox-1",
    });
    const receive = vi.fn().mockResolvedValue({ id: "group-eve-session-1" });

    await createAgentScheduleDispatcher({
      discardSession: vi.fn(),
      prepareHistory,
      prepareSession,
      receive,
      repository,
    } as never)(new Date("2026-07-17T06:00:00.000Z"));

    expect(prepareHistory).toHaveBeenCalledWith(groupJob);
    expect(prepareHistory.mock.invocationCallOrder[0])
      .toBeLessThan(repository.markDispatchStarted.mock.invocationCallOrder[0]!);
    expect(prepareSession.mock.invocationCallOrder[0])
      .toBeLessThan(repository.markDispatchStarted.mock.invocationCallOrder[0]!);
    expect(receive).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      auth: expect.objectContaining({
        attributes: expect.objectContaining({
          groupId: "group-1",
          groupType: "external",
          memoryScopes: ["group"],
          scheduledGroupHistory: "enabled",
          toolAllowlist: ["send_workspace_file"],
        }),
      }),
      target: { chatId: "-1001234567890", conversationId: "schedule:run-1" },
    }));
  });

  it("retires a prepared session when live authorization rejects the pre-handoff transition", async () => {
    const repository = {
      claimDue: vi.fn().mockResolvedValue([job]),
      failClaim: vi.fn(),
      markDispatchStarted: vi.fn().mockResolvedValue(false),
      markRunning: vi.fn(),
    };
    const discardSession = vi.fn();
    const receive = vi.fn();

    await createAgentScheduleDispatcher({
      discardSession,
      prepareHistory: vi.fn(),
      prepareSession: vi.fn().mockResolvedValue({
        continuationToken: "101::schedule:run-1",
        generation: 0,
        id: "revoked-session-1",
        rotated: false,
        sandboxSessionId: "revoked-sandbox-1",
      }),
      receive,
      repository,
    })(new Date("2026-07-17T06:00:00.000Z"));

    expect(discardSession).toHaveBeenCalledWith("revoked-session-1");
    expect(receive).not.toHaveBeenCalled();
    expect(repository.markRunning).not.toHaveBeenCalled();
  });

  it("retires a prepared session when Eve handoff fails before a session can run", async () => {
    const repository = {
      claimDue: vi.fn().mockResolvedValue([job]),
      failClaim: vi.fn(),
      markDispatchStarted: vi.fn().mockResolvedValue(true),
      markRunning: vi.fn(),
    };
    const discardSession = vi.fn();

    await createAgentScheduleDispatcher({
      discardSession,
      prepareHistory: vi.fn(),
      prepareSession: vi.fn().mockResolvedValue({
        continuationToken: "101::schedule:run-1",
        generation: 0,
        id: "failed-handoff-session-1",
        rotated: false,
        sandboxSessionId: "failed-handoff-sandbox-1",
      }),
      receive: vi.fn().mockRejectedValue(new Error("handoff failed")),
      repository,
    })(new Date("2026-07-17T06:00:00.000Z"));

    expect(repository.failClaim).toHaveBeenCalledWith(job, "AGENT_SCHEDULE_HANDOFF_FAILED");
    expect(discardSession).toHaveBeenCalledWith("failed-handoff-session-1");
    expect(repository.markRunning).not.toHaveBeenCalled();
  });

  it("continues the claimed batch when one dispatch marker fails", async () => {
    const secondJob = {
      ...job,
      id: "schedule-2",
      leaseToken: "lease-2",
      runId: "run-2",
    };
    const repository = {
      claimDue: vi.fn().mockResolvedValue([job, secondJob]),
      failClaim: vi.fn(),
      markDispatchStarted: vi.fn()
        .mockRejectedValueOnce(new Error("marker unavailable"))
        .mockResolvedValueOnce(true),
      markRunning: vi.fn(),
    };
    const receive = vi.fn().mockResolvedValue({ id: "eve-session-2" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const dispatched = await createAgentScheduleDispatcher({
      discardSession: vi.fn(),
      prepareHistory: vi.fn(),
      prepareSession: vi.fn().mockImplementation(async (claimedJob: ClaimedAgentSchedule) => ({
        continuationToken: `101::schedule:${claimedJob.runId}`,
        generation: 0,
        id: `app-${claimedJob.runId}`,
        rotated: false,
        sandboxSessionId: `sandbox-${claimedJob.runId}`,
      })),
      receive,
      repository,
    })(new Date("2026-07-17T06:00:00.000Z"));

    expect(dispatched).toBe(2);
    expect(receive).toHaveBeenCalledTimes(1);
    expect(repository.markRunning).toHaveBeenCalledWith(secondJob, {
      applicationSessionId: "app-run-2",
      eveSessionId: "eve-session-2",
    });
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("AGENT_SCHEDULE_DISPATCH_FAILED"));
    consoleError.mockRestore();
  });

  it("continues the claimed batch when rejected authorization cleanup fails", async () => {
    const secondJob = {
      ...job,
      id: "schedule-2",
      leaseToken: "lease-2",
      runId: "run-2",
    };
    const repository = {
      claimDue: vi.fn().mockResolvedValue([job, secondJob]),
      failClaim: vi.fn(),
      markDispatchStarted: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      markRunning: vi.fn(),
    };
    const discardSession = vi.fn().mockRejectedValueOnce(new Error("cleanup unavailable"));
    const receive = vi.fn().mockResolvedValue({ id: "eve-session-2" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await createAgentScheduleDispatcher({
      discardSession,
      prepareHistory: vi.fn(),
      prepareSession: vi.fn().mockImplementation(async (claimedJob: ClaimedAgentSchedule) => ({
        continuationToken: `101::schedule:${claimedJob.runId}`,
        generation: 0,
        id: `app-${claimedJob.runId}`,
        rotated: false,
        sandboxSessionId: `sandbox-${claimedJob.runId}`,
      })),
      receive,
      repository,
    })(new Date("2026-07-17T06:00:00.000Z"));

    expect(discardSession).toHaveBeenCalledWith("app-run-1");
    expect(receive).toHaveBeenCalledTimes(1);
    expect(repository.markRunning).toHaveBeenCalledWith(secondJob, {
      applicationSessionId: "app-run-2",
      eveSessionId: "eve-session-2",
    });
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("AGENT_SCHEDULE_DISPATCH_FAILED"));
    consoleError.mockRestore();
  });
});
