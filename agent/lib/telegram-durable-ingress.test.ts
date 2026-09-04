/**
 * Durable Telegram ingress coordinator tests.
 *
 * Constructs covered:
 * - Webhook ACK waits only for persistence, never voice transcription or Eve execution.
 * - External media is acknowledged without entering the durable queue or native dispatch.
 * - Voice results persist once before native Eve dispatch.
 * - Captionless attachments receive a non-empty factual model message after durable storage.
 * - FIFO releases at a waiting boundary even though the durable session stream remains open.
 * - Reused Eve sessions start at the persisted stream cursor and ignore an old waiting boundary.
 * - A callback whose approval settles while other prompts stay unanswered completes at once.
 * - Chats drain in parallel up to a bound; one long turn never holds every other chat.
 */
import type { TelegramVerifiedUpdateContext } from "eve/channels/telegram";
import { parseTelegramUpdate } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import type { TelegramIngressRepository } from "./telegram-ingress-contract.js";
import { createTelegramDurableIngress } from "./telegram-durable-ingress.js";

const BOUNDARY_SETTLEMENT_TIMEOUT_MILLISECONDS = 100;

function voicePayload(): Record<string, unknown> {
  return {
    message: {
      chat: { id: 101, type: "private" },
      date: 1_700_000_000,
      from: { first_name: "Анна", id: 101, is_bot: false },
      message_id: 77,
      voice: {
        file_id: "voice-file-1",
        file_size: 512,
        mime_type: "audio/ogg",
      },
    },
    update_id: 1001,
  };
}

function repository() {
  const claim = {
    attemptCount: 1,
    deliveryContinuationKey: "101::",
    ingressContinuationKey: "101::",
    leaseExpiresAt: new Date(Date.now() + 60_000),
    leaseToken: "123e4567-e89b-42d3-a456-426614174000",
    payload: voicePayload(),
    queueId: "123e4567-e89b-42d3-a456-426614174001",
    transcript: null,
    updateId: "1001",
    voice: { fileId: "voice-file-1", fileSize: 512, mimeType: "audio/ogg" },
  };
  return {
    claim,
    value: {
      acceptMedia: vi.fn().mockResolvedValue(true),
      beginDispatch: vi.fn(),
      beginVoiceTranscription: vi.fn().mockResolvedValue("started"),
      claimNext: vi.fn().mockResolvedValueOnce(claim).mockResolvedValueOnce(null),
      complete: vi.fn(),
      completeWithSession: vi.fn(),
      enqueue: vi.fn().mockResolvedValue("inserted"),
      fail: vi.fn(),
      hasPendingApprovals: vi.fn().mockResolvedValue(false),
      rekeyQueue: vi.fn(),
      release: vi.fn(),
      releaseStaleLeases: vi.fn().mockResolvedValue(0),
      renewLease: vi.fn(),
      sessionEventStreamCursor: vi.fn().mockResolvedValue(0),
      saveVoiceTranscript: vi.fn(),
    } satisfies TelegramIngressRepository,
  };
}

describe("createTelegramDurableIngress", () => {
  it("releases leases left by a previous process once, before the first claim of this process", async () => {
    const storage = repository();
    storage.value.claimNext.mockReset().mockResolvedValue(null);
    storage.value.releaseStaleLeases.mockResolvedValue(1);
    const handle = createTelegramDurableIngress({
      acceptMedia: vi.fn().mockResolvedValue(true),
      authorizeVoice: vi.fn().mockResolvedValue(true),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      repository: storage.value,
      transcribeVoice: vi.fn(),
    });
    const tasks: Promise<unknown>[] = [];
    const context = { dispatch: vi.fn(), waitUntil: (task: Promise<unknown>) => tasks.push(task) } as never;

    await handle.drain(context);
    await Promise.all(tasks);
    await handle.drain(context);
    await Promise.all(tasks);

    expect(storage.value.releaseStaleLeases).toHaveBeenCalledTimes(1);
    expect(storage.value.claimNext).toHaveBeenCalledTimes(2);
    expect(storage.value.releaseStaleLeases.mock.invocationCallOrder[0]!)
      .toBeLessThan(storage.value.claimNext.mock.invocationCallOrder[0]!);
  });

  it("acknowledges after enqueue and processes voice in the background", async () => {
    const storage = repository();
    const transcribeVoice = vi.fn().mockResolvedValue("Купи молоко");
    let sessionStreamController: ReadableStreamDefaultController<{ type: string }> | undefined;
    const dispatch = vi.fn().mockResolvedValue({
      getEventStream: async () =>
        new ReadableStream({
          start(controller) {
            sessionStreamController = controller;
            controller.enqueue({ type: "session.waiting" });
          },
        }),
      id: "session-1",
    });
    let backgroundTask: Promise<unknown> | undefined;
    const raw = voicePayload();
    const update = parseTelegramUpdate(raw);
    if (!update) throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое обновление");
    const handle = createTelegramDurableIngress({
      acceptMedia: vi.fn().mockResolvedValue(true),
      authorizeVoice: vi.fn().mockResolvedValue(true),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      repository: storage.value,
      transcribeVoice,
    });

    const response = await handle({
      dispatch,
      raw,
      update,
      waitUntil(task) {
        backgroundTask = task;
      },
    } as TelegramVerifiedUpdateContext);

    expect(response.status).toBe(200);
    expect(storage.value.enqueue).toHaveBeenCalledTimes(1);
    expect(transcribeVoice).not.toHaveBeenCalled();
    if (!backgroundTask) {
      throw new Error("AGENT_TEST_BACKGROUND_TASK_MISSING: Durable ingress did not schedule a drain");
    }

    // Eve keeps the durable stream open for future turns, so waiting must itself settle the drain.
    const settledAtBoundary = await Promise.race([
      backgroundTask.then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), BOUNDARY_SETTLEMENT_TIMEOUT_MILLISECONDS);
      }),
    ]);
    if (!settledAtBoundary) {
      sessionStreamController?.close();
      await backgroundTask;
    }

    expect(settledAtBoundary).toBe(true);
    expect(transcribeVoice).toHaveBeenCalledTimes(1);
    expect(storage.value.beginVoiceTranscription).toHaveBeenCalledWith(
      "1001",
      storage.claim.leaseToken,
    );
    expect(storage.value.saveVoiceTranscript).toHaveBeenCalledWith(
      "1001",
      storage.claim.leaseToken,
      "Купи молоко",
    );
    expect(dispatch.mock.calls[0]?.[0].message.text).toBe("Купи молоко");
    expect(storage.value.beginDispatch).toHaveBeenCalledWith(
      "1001",
      storage.claim.leaseToken,
    );
    expect(storage.value.completeWithSession).toHaveBeenCalledWith(
      "1001",
      storage.claim.leaseToken,
      "session-1",
      1,
    );
  });

  it("does not let an old session.waiting complete a newly dispatched turn", async () => {
    const storage = repository();
    storage.value.sessionEventStreamCursor.mockResolvedValue(2);
    const requestedStartIndexes: number[] = [];
    const dispatch = vi.fn().mockResolvedValue({
      getEventStream: async (options?: { startIndex?: number }) => {
        requestedStartIndexes.push(options?.startIndex ?? 0);
        return new ReadableStream({
          start(controller) {
            // The old waiting event is at index 1 and must be excluded by startIndex=2.
            controller.enqueue({ type: "turn.started" });
            controller.enqueue({ type: "turn.completed" });
            controller.enqueue({ type: "session.waiting" });
          },
        });
      },
      id: "session-reused",
    });
    const raw = voicePayload();
    const update = parseTelegramUpdate(raw);
    if (!update) throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое обновление");
    const handle = createTelegramDurableIngress({
      acceptMedia: vi.fn().mockResolvedValue(true),
      authorizeVoice: vi.fn().mockResolvedValue(false),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      repository: storage.value,
      transcribeVoice: vi.fn(),
    });
    let backgroundTask: Promise<unknown> | undefined;

    await handle({
      dispatch,
      raw,
      update,
      waitUntil(task) {
        backgroundTask = task;
      },
    } as TelegramVerifiedUpdateContext);
    await backgroundTask;

    expect(requestedStartIndexes).toEqual([2]);
    expect(storage.value.completeWithSession).toHaveBeenCalledWith(
      "1001",
      storage.claim.leaseToken,
      "session-reused",
      5,
    );
  });

  it("releases a callback dispatch when Eve settles an approval without resuming the turn", async () => {
    const storage = repository();
    const raw = {
      callback_query: {
        chat_instance: "1",
        data: "eve:0",
        from: { first_name: "Анна", id: 101, is_bot: false },
        id: "cb-1",
        message: {
          chat: { id: 101, type: "private" },
          date: 1_700_000_000,
          from: { first_name: "Мия", id: 7, is_bot: true },
          message_id: 88,
          text: "Подтвердите действие",
        },
      },
      update_id: 1002,
    };
    storage.claim.payload = raw;
    storage.claim.updateId = "1002";
    storage.claim.voice = null as never;
    const update = parseTelegramUpdate(raw);
    if (!update) throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое обновление");
    storage.value.hasPendingApprovals.mockResolvedValue(true);
    const dispatch = vi.fn().mockResolvedValue({
      getEventStream: async () =>
        new ReadableStream({
          start(controller) {
            // A partially answered batch settles one approval and then stays parked forever.
            controller.enqueue({ type: "approval.settled" });
          },
        }),
      id: "session-parked",
    });
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});
    const handle = createTelegramDurableIngress({
      acceptMedia: vi.fn().mockResolvedValue(true),
      authorizeVoice: vi.fn(),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      repository: storage.value,
      transcribeVoice: vi.fn(),
    });
    let backgroundTask: Promise<unknown> | undefined;

    await handle({
      dispatch,
      raw,
      update,
      waitUntil(task) {
        backgroundTask = task;
      },
    } as TelegramVerifiedUpdateContext);
    const released = await Promise.race([
      backgroundTask!.then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), 1_000);
      }),
    ]);

    expect(released).toBe(true);
    expect(storage.value.completeWithSession).toHaveBeenCalledWith(
      "1002",
      storage.claim.leaseToken,
      "session-parked",
      1,
    );
    expect(storage.value.hasPendingApprovals).toHaveBeenCalledWith("session-parked");
    expect(logged.mock.calls.some(([line]) =>
      String(line).includes("AGENT_TELEGRAM_APPROVAL_BATCH_PENDING"))).toBe(true);
    logged.mockRestore();
  });

  it("keeps waiting for the boundary when a settled approval resumes the turn", async () => {
    const storage = repository();
    const raw = {
      callback_query: {
        chat_instance: "1",
        data: "eve:0",
        from: { first_name: "Анна", id: 101, is_bot: false },
        id: "cb-2",
        message: {
          chat: { id: 101, type: "private" },
          date: 1_700_000_000,
          from: { first_name: "Мия", id: 7, is_bot: true },
          message_id: 88,
          text: "Подтвердите действие",
        },
      },
      update_id: 1003,
    };
    storage.claim.payload = raw;
    storage.claim.updateId = "1003";
    storage.claim.voice = null as never;
    const update = parseTelegramUpdate(raw);
    if (!update) throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое обновление");
    const dispatch = vi.fn().mockResolvedValue({
      getEventStream: async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "approval.settled" });
            controller.enqueue({ type: "input.resolved" });
            controller.enqueue({ type: "turn.started" });
            setTimeout(() => {
              controller.enqueue({ type: "turn.completed" });
              controller.enqueue({ type: "session.waiting" });
            }, 60);
          },
        }),
      id: "session-resumed",
    });
    const handle = createTelegramDurableIngress({
      acceptMedia: vi.fn().mockResolvedValue(true),
      authorizeVoice: vi.fn(),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      repository: storage.value,
      transcribeVoice: vi.fn(),
    });
    let backgroundTask: Promise<unknown> | undefined;

    await handle({
      dispatch,
      raw,
      update,
      waitUntil(task) {
        backgroundTask = task;
      },
    } as TelegramVerifiedUpdateContext);
    await backgroundTask;

    expect(storage.value.completeWithSession).toHaveBeenCalledWith(
      "1003",
      storage.claim.leaseToken,
      "session-resumed",
      5,
    );
  });

  it("drains different chats in parallel while one turn is still running", async () => {
    const storage = repository();
    const first = { ...storage.claim, ingressContinuationKey: "101::", updateId: "1001" };
    const second = {
      ...storage.claim,
      deliveryContinuationKey: "102::",
      ingressContinuationKey: "102::",
      payload: { ...voicePayload(), message: { ...(voicePayload().message as object), chat: { id: 102, type: "private" } }, update_id: 1002 },
      queueId: "123e4567-e89b-42d3-a456-426614174002",
      updateId: "1002",
    };
    storage.value.claimNext.mockReset()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValue(null);
    let releaseFirstTurn: (() => void) | undefined;
    const firstTurnReleased = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });
    const dispatched: string[] = [];
    const dispatch = vi.fn().mockImplementation(async (update: { message: { chat: { id: number } } }) => {
      const chatId = String(update.message.chat.id);
      dispatched.push(chatId);
      return {
        getEventStream: async () =>
          new ReadableStream({
            async start(controller) {
              // Chat 101 stays busy until the test releases it; chat 102 answers at once.
              if (chatId === "101") await firstTurnReleased;
              controller.enqueue({ type: "session.waiting" });
            },
          }),
        id: `session-${chatId}`,
      };
    });
    const handle = createTelegramDurableIngress({
      acceptMedia: vi.fn().mockResolvedValue(true),
      authorizeVoice: vi.fn().mockResolvedValue(false),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      maxConcurrentDrains: 2,
      repository: storage.value,
      transcribeVoice: vi.fn(),
    });
    const tasks: Promise<unknown>[] = [];
    const context = { dispatch, waitUntil: (task: Promise<unknown>) => tasks.push(task) } as never;

    await handle.drain(context);
    await handle.drain(context);
    const secondCompleted = await Promise.race([
      new Promise<boolean>((resolve) => {
        const poll = setInterval(() => {
          if (storage.value.completeWithSession.mock.calls.some(([id]) => id === "1002")) {
            clearInterval(poll);
            resolve(true);
          }
        }, 5);
      }),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), 500);
      }),
    ]);
    releaseFirstTurn!();
    await Promise.all(tasks);

    expect(dispatched).toEqual(["101", "102"]);
    expect(secondCompleted).toBe(true);
    expect(storage.value.completeWithSession).toHaveBeenCalledWith(
      "1001",
      storage.claim.leaseToken,
      "session-101",
      1,
    );
  });

  it("acknowledges rejected external media without enqueue, download, or dispatch", async () => {
    const storage = repository();
    storage.value.claimNext.mockReset().mockResolvedValue(null);
    const acceptMedia = vi.fn().mockResolvedValue(false);
    const transcribeVoice = vi.fn();
    const dispatch = vi.fn();
    const waitUntil = vi.fn();
    const raw = voicePayload();
    const rawMessage = raw.message as Record<string, unknown>;
    rawMessage.chat = { id: -1001, type: "supergroup" };
    const update = parseTelegramUpdate(raw);
    if (!update || update.kind !== "message") {
      throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое сообщение");
    }
    const handle = createTelegramDurableIngress({
      acceptMedia,
      authorizeVoice: vi.fn(),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      repository: storage.value,
      transcribeVoice,
    });

    const response = await handle({ dispatch, raw, update, waitUntil } as TelegramVerifiedUpdateContext);

    expect(response.status).toBe(200);
    expect(acceptMedia).toHaveBeenCalledWith(update.message, "1001", "unsupported_media");
    expect(storage.value.enqueue).not.toHaveBeenCalled();
    expect(transcribeVoice).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("dispatches a captionless photo with a non-empty factual model message", async () => {
    const storage = repository();
    const raw = {
      message: {
        chat: { id: 101, type: "private" },
        date: 1_700_000_000,
        from: { first_name: "Анна", id: 101, is_bot: false },
        message_id: 78,
        photo: [{
          file_id: "photo-file-1",
          file_size: 1_024,
          file_unique_id: "photo-unique-1",
          height: 640,
          width: 640,
        }],
      },
      update_id: 1002,
    };
    Object.assign(storage.claim, { payload: raw, updateId: "1002", voice: null });
    const update = parseTelegramUpdate(raw);
    if (!update || update.kind !== "message") {
      throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое сообщение");
    }
    const dispatch = vi.fn().mockResolvedValue(null);
    let backgroundTask: Promise<unknown> | undefined;
    const handle = createTelegramDurableIngress({
      acceptMedia: vi.fn().mockResolvedValue(true),
      authorizeVoice: vi.fn(),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      repository: storage.value,
      transcribeVoice: vi.fn(),
    });

    await handle({
      dispatch,
      raw,
      update,
      waitUntil(task) {
        backgroundTask = task;
      },
    } as TelegramVerifiedUpdateContext);
    if (!backgroundTask) {
      throw new Error("AGENT_TEST_BACKGROUND_TASK_MISSING: Durable ingress did not schedule a drain");
    }
    await backgroundTask;

    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      kind: "message",
      message: {
        attachments: [expect.objectContaining({ fileId: "photo-file-1", kind: "photo" })],
        text: "Пользователь отправил файл без подписи.",
      },
    });
    expect((raw.message as Record<string, unknown>).text).toBeUndefined();
  });
});
