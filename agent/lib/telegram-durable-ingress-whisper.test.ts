/**
 * Durable ingress of ephemeral messages (Bot API ephemeral commands, `/whisper`).
 *
 * Constructs covered:
 * - An accepted whisper is queued in its own lane (chat and person), never in the group's, with
 *   the placeholder the gate sent stored in the update.
 * - Any other ephemeral message, or a whisper the gate refused, is acknowledged and never queued:
 *   its `message_id` is 0, and the group journal and queue are keyed by message and chat.
 * - Without a configured gate every ephemeral message is dropped.
 * - A redelivered whisper (Telegram retried the webhook) differs only by its new placeholder: the
 *   update is already queued, so the new placeholder is removed and the update acknowledged.
 * - A queue write that failed without a clear answer keeps the placeholder: it may have committed
 *   (the minute sweep removes it if nothing was stored).
 * - A whisper that fails in the drain is told to its author (in the placeholder), while a failed
 *   ordinary group message stays silent; so is a whisper whose Eve session failed outright.
 */
import type { TelegramVerifiedUpdateContext } from "eve/channels/telegram";
import { parseTelegramUpdate } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import { AppError } from "./app-error.js";
import type { TelegramIngressRepository } from "./telegram-ingress-contract.js";
import { createTelegramDurableIngress } from "./telegram-durable-ingress.js";
import type { TelegramWhisperGate } from "./whisper/telegram-whisper-gate.js";

function ephemeralPayload(text = "/whisper о чём спор?"): Record<string, unknown> {
  return {
    message: {
      chat: { id: -1001, title: "Группа", type: "supergroup" },
      date: 1_700_000_000,
      entities: [{ length: 8, offset: 0, type: "bot_command" }],
      ephemeral_message_id: 7,
      from: { first_name: "Анна", id: 101, is_bot: false },
      message_id: 0,
      text,
    },
    update_id: 2001,
  };
}

function storage() {
  return {
    acceptMedia: vi.fn().mockResolvedValue(true),
    beginDispatch: vi.fn(),
    beginVoiceTranscription: vi.fn(),
    claimFollowing: vi.fn().mockResolvedValue([]),
    claimNext: vi.fn().mockResolvedValue(null),
    complete: vi.fn(),
    completeWithSession: vi.fn(),
    enqueue: vi.fn().mockResolvedValue("inserted"),
    fail: vi.fn(),
    hasPendingApprovals: vi.fn().mockResolvedValue(false),
    hasPendingApprovalsInChat: vi.fn().mockResolvedValue(false),
    listPendingAfter: vi.fn().mockResolvedValue([]),
    rekeyQueue: vi.fn(),
    release: vi.fn(),
    releaseStaleLeases: vi.fn().mockResolvedValue(0),
    releaseUndelivered: vi.fn(),
    renewLease: vi.fn(),
    sessionEventStreamCursor: vi.fn().mockResolvedValue(0),
    saveVoiceTranscript: vi.fn(),
  } satisfies TelegramIngressRepository;
}

const MARKER = { ephemeralMessageId: 7, placeholderMessageId: 31, receiverUserId: "101" };

function ingress(
  repository: ReturnType<typeof storage>,
  whisper?: { close: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn> },
) {
  return createTelegramDurableIngress({
    acceptMedia: vi.fn().mockResolvedValue(true),
    authorizeVoice: vi.fn(),
    botUsername: "osinara_bot",
    handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
    leaseMilliseconds: 60_000,
    noteInboundMessage: vi.fn().mockResolvedValue(undefined),
    repository,
    transcribeVoice: vi.fn(),
    ...(whisper ? { whisper: whisper as unknown as TelegramWhisperGate } : {}),
  });
}

function verified(raw: Record<string, unknown>): TelegramVerifiedUpdateContext {
  const update = parseTelegramUpdate(raw);
  if (!update) throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое сообщение");
  return {
    dispatch: vi.fn(),
    raw,
    update,
    waitUntil: vi.fn(),
  } as unknown as TelegramVerifiedUpdateContext;
}

describe("durable ingress of ephemeral messages", () => {
  it("queues an accepted whisper in its own lane with the placeholder it got", async () => {
    const repository = storage();
    const whisper = { close: vi.fn(), open: vi.fn().mockResolvedValue(MARKER) };
    const raw = ephemeralPayload();

    const response = await ingress(repository, whisper)(verified(raw));

    expect(response.status).toBe(200);
    expect(whisper.open).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ messageId: "0", text: "/whisper о чём спор?" }),
      "2001",
    );
    expect(repository.enqueue).toHaveBeenCalledExactlyOnceWith({
      continuationKey: "telegram:whisper:-1001:101",
      payload: { ...raw, message: { ...(raw.message as object), osinara_whisper: MARKER } },
      updateId: "2001",
    });
    expect(whisper.close).not.toHaveBeenCalled();
  });

  it("never queues an ephemeral message the gate did not accept", async () => {
    const repository = storage();
    const whisper = { close: vi.fn(), open: vi.fn().mockResolvedValue(null) };

    const response = await ingress(repository, whisper)(verified(ephemeralPayload("/ask привет")));

    expect(response.status).toBe(200);
    expect(repository.enqueue).not.toHaveBeenCalled();
  });

  it("drops every ephemeral message when no gate is configured", async () => {
    const repository = storage();

    const response = await ingress(repository)(verified(ephemeralPayload()));

    expect(response.status).toBe(200);
    expect(repository.enqueue).not.toHaveBeenCalled();
  });

  it("removes the second placeholder of a redelivered whisper", async () => {
    const repository = storage();
    repository.enqueue.mockRejectedValueOnce(
      new AppError(
        "AGENT_TELEGRAM_UPDATE_CONFLICT",
        "Telegram повторно прислал идентификатор обновления с другими данными. Обработка остановлена",
      ),
    );
    const whisper = {
      close: vi.fn().mockResolvedValue(undefined),
      open: vi.fn().mockResolvedValue(MARKER),
    };

    const response = await ingress(repository, whisper)(verified(ephemeralPayload()));

    expect(response.status).toBe(200);
    expect(whisper.close).toHaveBeenCalledExactlyOnceWith("-1001", MARKER);
  });

  it("keeps the placeholder when the queue write fails without a clear answer", async () => {
    const repository = storage();
    repository.enqueue.mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));
    const whisper = {
      close: vi.fn().mockResolvedValue(undefined),
      open: vi.fn().mockResolvedValue(MARKER),
    };

    await expect(ingress(repository, whisper)(verified(ephemeralPayload()))).rejects.toThrow(
      "Connection terminated",
    );

    // The write may have committed: removing the placeholder would leave that whisper unanswerable.
    expect(whisper.close).not.toHaveBeenCalled();
  });

  it("tells a whisper whose dispatch failed in its placeholder, unlike a group message", async () => {
    const repository = storage();
    const payload = ephemeralPayload();
    (payload.message as Record<string, unknown>).osinara_whisper = MARKER;
    const claim = {
      attemptCount: 1,
      deliveryContinuationKey: "telegram:whisper:-1001:101",
      ingressContinuationKey: "telegram:whisper:-1001:101",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      leaseToken: "123e4567-e89b-42d3-a456-426614174000",
      payload,
      queueId: "123e4567-e89b-42d3-a456-426614174001",
      transcript: null,
      updateId: "2001",
      voice: null,
    };
    repository.claimNext.mockResolvedValueOnce(claim).mockResolvedValueOnce(null);
    repository.beginDispatch.mockRejectedValueOnce(
      new AppError(
        "AGENT_TELEGRAM_DISPATCH_RECOVERY_REQUIRED",
        "Не уверена, что обработала это сообщение",
      ),
    );
    const notifyFailure = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handle = createTelegramDurableIngress({
      acceptMedia: vi.fn(),
      authorizeVoice: vi.fn(),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      notifyFailure,
      repository,
      transcribeVoice: vi.fn(),
    });
    const tasks: Promise<unknown>[] = [];

    await handle.drain({
      dispatch: vi.fn(),
      waitUntil: (task: Promise<unknown>) => tasks.push(task),
    } as never);
    await Promise.all(tasks.map((task) => task.catch(() => undefined)));

    expect(repository.fail.mock.calls.map((call) => call[0])).toEqual(["2001"]);
    expect(notifyFailure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: expect.objectContaining({
          raw: expect.objectContaining({ osinara_whisper: MARKER }),
        }),
      }),
      expect.objectContaining({ code: "AGENT_TELEGRAM_DISPATCH_RECOVERY_REQUIRED" }),
    );
  });

  it("tells a whisper whose session failed before any turn could tell it", async () => {
    const repository = storage();
    const payload = ephemeralPayload();
    (payload.message as Record<string, unknown>).osinara_whisper = MARKER;
    repository.claimNext
      .mockResolvedValueOnce({
        attemptCount: 1,
        deliveryContinuationKey: "telegram:whisper:-1001:101",
        ingressContinuationKey: "telegram:whisper:-1001:101",
        leaseExpiresAt: new Date(Date.now() + 60_000),
        leaseToken: "123e4567-e89b-42d3-a456-426614174000",
        payload,
        queueId: "123e4567-e89b-42d3-a456-426614174001",
        transcript: null,
        updateId: "2001",
        voice: null,
      })
      .mockResolvedValueOnce(null);
    const failedSession = {
      getEventStream: async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "session.failed" });
            controller.close();
          },
        }),
      id: "eve-whisper-1",
    };
    const notifyFailure = vi.fn().mockResolvedValue(undefined);
    const handle = createTelegramDurableIngress({
      acceptMedia: vi.fn(),
      authorizeVoice: vi.fn(),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      notifyFailure,
      repository,
      transcribeVoice: vi.fn(),
    });
    const tasks: Promise<unknown>[] = [];

    await handle.drain({
      dispatch: vi.fn().mockResolvedValue(failedSession),
      waitUntil: (task: Promise<unknown>) => tasks.push(task),
    } as never);
    await Promise.all(tasks);

    expect(repository.completeWithSession).toHaveBeenCalledOnce();
    expect(notifyFailure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: expect.objectContaining({
          raw: expect.objectContaining({ osinara_whisper: MARKER }),
        }),
      }),
      expect.objectContaining({ code: "AGENT_TELEGRAM_SESSION_FAILED" }),
    );
  });

  it("keeps an ordinary group message on the group's queue", async () => {
    const repository = storage();
    const whisper = { close: vi.fn(), open: vi.fn() };
    const raw = ephemeralPayload("Мия, привет");
    const message = raw.message as Record<string, unknown>;
    delete message.ephemeral_message_id;
    message.message_id = 55;

    await ingress(repository, whisper)(verified(raw));

    expect(whisper.open).not.toHaveBeenCalled();
    expect(repository.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ continuationKey: "-1001::" }),
    );
  });
});
