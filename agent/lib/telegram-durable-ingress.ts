/**
 * Durable Telegram ingress coordinator.
 *
 * Exports:
 * - `createTelegramDurableIngress`: verified Eve hook that persists before ACK and drains FIFO.
 * - `handleTelegramDurableIngress`: production hook with PostgreSQL and Groq dependencies.
 * - Application software-update callbacks complete before native Eve dispatch begins.
 */
import type {
  TelegramDrainContext,
  TelegramMessage,
  TelegramUpdate,
  TelegramVerifiedUpdateContext,
} from "eve/channels/telegram";
import { parseTelegramUpdate, telegramContinuationToken } from "eve/channels/telegram";
import { z } from "zod";

import { TELEGRAM_INGRESS_LEASE_MS } from "../config.js";
import { AppError, isAppError } from "./app-error.js";
import { transcribeTelegramVoice } from "./groq-voice-transcription.js";
import type { TelegramIngressClaim, TelegramIngressRepository } from "./telegram-ingress-contract.js";
import { telegramIngressRepository } from "./telegram-ingress-repository.js";
import {
  classifyTelegramInboundMedia,
  isMessageAddressedToBot,
  type TelegramInboundMediaKind,
} from "./telegram-message-policy.js";
import { createTelegramVoiceAuthorizer } from "./telegram-voice-authorization.js";
import {
  TELEGRAM_SERIES_MAX_MESSAGES,
  continuesSeries,
  isSeriesEligible,
  type TelegramSeriesMarker,
  withSeriesMarker,
} from "./telegram-message-series.js";
import {
  pendingMessagesFromPayloads,
  TELEGRAM_PENDING_MESSAGES_MAX,
  type TelegramPendingMessage,
  withPendingMarker,
} from "./telegram-pending-messages.js";
import { withRichMessageText } from "./telegram-rich-message.js";
import { telegramRepository } from "./telegram-repository.js";
import { handleSoftwareUpdateCallback } from "./software-updates/callback.js";

const telegramUpdateIdSchema = z.union([z.number().int().nonnegative().safe(), z.string().regex(/^\d+$/)]);
const telegramVoiceSchema = z.object({
  message: z
    .object({
      voice: z.object({
        file_id: z.string().min(1),
        file_size: z.number().int().positive().optional(),
        mime_type: z.string().min(1).optional(),
      }),
    })
    .passthrough(),
  update_id: telegramUpdateIdSchema,
});

interface EveSessionResult {
  getEventStream(options?: { startIndex?: number }): Promise<ReadableStream<{ type: string }>>;
  id: string;
}

interface DurableIngressDependencies {
  acceptMedia(
    message: Pick<TelegramMessage, "chat">,
    updateId: string,
    mediaKind: Exclude<TelegramInboundMediaKind, "none">,
  ): Promise<boolean>;
  authorizeVoice(message: Pick<TelegramMessage, "chat" | "from">): Promise<boolean>;
  botUsername: string;
  /**
   * Drain loops allowed at once. `claimNext` keeps every chat/topic FIFO on its own, so parallel
   * loops only stop one long turn from holding every other chat and every approval button.
   */
  maxConcurrentDrains?: number;
  handleSoftwareUpdateCallback(
    query: Extract<TelegramUpdate, { kind: "callback_query" }>["callbackQuery"],
  ): Promise<boolean>;
  leaseMilliseconds: number;
  repository: TelegramIngressRepository;
  transcribeVoice(input: {
    fileId: string;
    fileSize?: number;
    mimeType?: string;
  }): Promise<string>;
}

interface TelegramDurableIngressHandler {
  (context: TelegramVerifiedUpdateContext): Promise<Response>;
  drain(context: TelegramDrainContext): Promise<Response>;
}

const LEASE_HEARTBEAT_DIVISOR = 3;
const CAPTIONLESS_ATTACHMENT_MODEL_TEXT = "Пользователь отправил файл без подписи.";

function updateId(raw: Record<string, unknown>): string {
  const parsed = telegramUpdateIdSchema.safeParse(raw.update_id);
  if (!parsed.success) {
    throw new AppError(
      "AGENT_TELEGRAM_UPDATE_ID_INVALID",
      "Telegram передал некорректный идентификатор обновления. Проверьте журнал интеграции",
    );
  }
  return String(parsed.data);
}

function queueKey(update: TelegramUpdate): string {
  if (update.kind === "callback_query" && !update.callbackQuery.message) {
    return `telegram:callback:${update.callbackQuery.id}`;
  }
  const message =
    update.kind === "message" ? update.message : update.callbackQuery.message!;

  // One FIFO per chat/topic is stricter than Eve's reply branches and avoids cross-anchor races.
  return telegramContinuationToken({
    chatId: message.chat.id,
    messageThreadId: message.messageThreadId,
  });
}

function voiceMetadata(raw: Record<string, unknown>) {
  const parsed = telegramVoiceSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const voice = parsed.data.message.voice;
  return {
    fileId: voice.file_id,
    ...(voice.file_size === undefined ? {} : { fileSize: voice.file_size }),
    ...(voice.mime_type === undefined ? {} : { mimeType: voice.mime_type }),
  };
}

const DEFAULT_MAX_CONCURRENT_DRAINS = 3;

async function waitForSessionBoundary(
  session: EveSessionResult,
  startIndex: number,
  options: {
    /** Whether the Eve session still has unanswered prompts after the delivered answer. */
    hasPendingApprovals?: () => Promise<boolean>;
    updateId: string;
  },
): Promise<number> {
  const stream = await session.getEventStream({ startIndex });
  const reader = stream.getReader();
  let reachedBoundary = false;
  let nextEventIndex = startIndex;
  try {
    while (true) {
      const event = await reader.read();
      if (event.done) break;
      nextEventIndex += 1;
      if (
        event.value.type === "session.waiting" ||
        event.value.type === "session.completed" ||
        event.value.type === "session.failed"
      ) {
        reachedBoundary = true;
        break;
      }
      if (
        event.value.type === "approval.settled" &&
        options.hasPendingApprovals !== undefined &&
        await options.hasPendingApprovals()
      ) {
        // Eve resumes a parked step only once every prompt of the session is answered, and the
        // remaining answers can arrive only through this drain. This delivery is complete.
        console.info(JSON.stringify({
          code: "AGENT_TELEGRAM_APPROVAL_BATCH_PENDING",
          sessionId: session.id,
          updateId: options.updateId,
        }));
        reachedBoundary = true;
        break;
      }
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  if (!reachedBoundary) {
    throw new AppError(
      "AGENT_TELEGRAM_SESSION_BOUNDARY_MISSING",
      "Eve завершил поток без подтверждения состояния сессии Telegram",
    );
  }
  return nextEventIndex;
}

function shouldTranscribeVoice(message: TelegramMessage, botUsername: string): boolean {
  const dispatchText = [message.text, message.caption].filter(Boolean).join("\n");
  return isMessageAddressedToBot({ ...message, text: dispatchText }, botUsername);
}

function withCaptionlessAttachmentText(update: TelegramUpdate): TelegramUpdate {
  if (
    update.kind !== "message" ||
    update.message.attachments.length === 0 ||
    update.message.text.trim() ||
    update.message.caption.trim()
  ) {
    return update;
  }

  // Eve no longer forwards persisted bytes to the text-only primary model. Keep its final user
  // message non-empty while describing only the verified event, not inventing a file request.
  return {
    ...update,
    message: {
      ...update.message,
      text: CAPTIONLESS_ATTACHMENT_MODEL_TEXT,
    },
  };
}

function withTranscript(payload: Record<string, unknown>, transcript: string): Record<string, unknown> {
  const cloned = structuredClone(payload);
  const message = cloned.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new AppError(
      "AGENT_TELEGRAM_VOICE_INVALID",
      "Telegram передал неполные данные голосового сообщения. Запишите и отправьте его заново",
    );
  }
  (message as Record<string, unknown>).text = transcript;
  return cloned;
}

export function createTelegramDurableIngress(dependencies: DurableIngressDependencies) {
  const activeDrains = new Set<Promise<void>>();
  const maxConcurrentDrains = dependencies.maxConcurrentDrains ?? DEFAULT_MAX_CONCURRENT_DRAINS;

  async function maintainLease(
    updateId: string,
    leaseToken: string,
    signal: AbortSignal,
  ): Promise<void> {
    const heartbeatMilliseconds = Math.floor(
      dependencies.leaseMilliseconds / LEASE_HEARTBEAT_DIVISOR,
    );
    while (!signal.aborted) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, heartbeatMilliseconds);
        signal.addEventListener("abort", () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });
      });
      if (signal.aborted) return;
      await dependencies.repository.renewLease(
        updateId,
        leaseToken,
        dependencies.leaseMilliseconds,
      );
    }
  }

  // Leases alive at the first drain of this process were held by a predecessor that died
  // mid-turn; releasing them once lets the affected chats resume in seconds instead of waiting
  // out the full lease. A redispatched update is deduplicated by the journal, so no turn repeats.
  let staleLeasesReleased = false;

  type LeasedUpdate = { claim: TelegramIngressClaim; update: TelegramUpdate };

  // A run of consecutive messages from the author of `head` is leased together so one turn can
  // answer it; anything else stays in the queue and forms the next claim.
  async function claimSeriesFollowers(
    head: TelegramIngressClaim,
    update: TelegramUpdate,
  ): Promise<LeasedUpdate[]> {
    if (!isSeriesEligible(update, dependencies.botUsername) || update.kind !== "message") return [];
    if (await dependencies.repository.hasPendingApprovalsInChat(update.message.chat.id)) return [];
    const followers = await dependencies.repository.claimFollowing({
      accept: (payload) => {
        const candidate = parseTelegramUpdate(payload);
        return candidate !== null &&
          continuesSeries(update, withRichMessageText(candidate), dependencies.botUsername);
      },
      afterUpdateId: head.updateId,
      leaseMilliseconds: dependencies.leaseMilliseconds,
      limit: TELEGRAM_SERIES_MAX_MESSAGES - 1,
      queueId: head.queueId,
    });
    return followers.map((claim) => {
      const parsed = parseTelegramUpdate(claim.payload);
      if (!parsed) {
        throw new AppError(
          "AGENT_TELEGRAM_PAYLOAD_INVALID",
          "Не удалось подготовить сообщение серии для обработки",
        );
      }
      return { claim, update: withRichMessageText(parsed) };
    });
  }

  function seriesMarker(series: readonly LeasedUpdate[], index: number): TelegramSeriesMarker | null {
    if (series.length === 1) return null;
    if (index < series.length - 1) return { role: "context" };
    const messages = series.map((item) => (item.update as { message: TelegramMessage }).message);
    return {
      addressed: messages.some((message) =>
        isMessageAddressedToBot(message, dependencies.botUsername)
      ),
      role: "current",
      telegramMessageIds: messages.slice(0, -1).map((message) => message.messageId),
    };
  }

  async function drain(
    dispatch: TelegramVerifiedUpdateContext["dispatch"],
  ): Promise<void> {
    if (!staleLeasesReleased) {
      staleLeasesReleased = true;
      const released = await dependencies.repository.releaseStaleLeases();
      if (released > 0) {
        console.warn(JSON.stringify({ code: "AGENT_TELEGRAM_INGRESS_LEASES_RELEASED", released }));
      }
    }
    while (true) {
      const claim = await dependencies.repository.claimNext(dependencies.leaseMilliseconds);
      if (!claim) return;
      const heartbeatController = new AbortController();
      let heartbeatError: unknown;
      const heartbeats: Promise<void>[] = [];
      const startHeartbeat = (leased: TelegramIngressClaim): void => {
        heartbeats.push(
          maintainLease(leased.updateId, leased.leaseToken, heartbeatController.signal)
            .catch((error: unknown) => {
              heartbeatError = error;
            }),
        );
      };
      startHeartbeat(claim);
      // Every leased update that has not reached a terminal state yet; a failure marks them all.
      const pending: TelegramIngressClaim[] = [claim];

      async function dispatchLeased(
        leased: TelegramIngressClaim,
        update: TelegramUpdate,
        marker: TelegramSeriesMarker | null,
        pendingAfter: readonly TelegramPendingMessage[],
      ): Promise<void> {
        await dependencies.repository.beginDispatch(leased.updateId, leased.leaseToken);
        const marked = marker !== null && update.kind === "message"
          ? withSeriesMarker(update, marker)
          : update;
        // The turn sees what the chat said after its message: otherwise it answered a snapshot
        // the conversation had already moved past, and two bots went in circles.
        const outbound = pendingAfter.length > 0 && marked.kind === "message"
          ? withPendingMarker(marked, pendingAfter)
          : marked;
        const session = (await dispatch(
          withCaptionlessAttachmentText(outbound),
        )) as EveSessionResult | null | undefined;
        if (!session) {
          await dependencies.repository.complete(leased.updateId, leased.leaseToken);
          return;
        }
        // The durable cursor excludes every event from earlier turns of a reused Eve session.
        const streamCursor = await dependencies.repository.sessionEventStreamCursor(session.id);
        const nextEventIndex = await waitForSessionBoundary(session, streamCursor, {
          ...(update.kind === "callback_query"
            ? {
              hasPendingApprovals: () =>
                dependencies.repository.hasPendingApprovals(session.id),
            }
            : {}),
          updateId: leased.updateId,
        });
        if (heartbeatError) throw heartbeatError;
        await dependencies.repository.completeWithSession(
          leased.updateId,
          leased.leaseToken,
          session.id,
          nextEventIndex,
        );
      }

      try {
        let payload = claim.payload;
        // Rich messages (Bot API 10.1) carry their text in blocks; Eve reads only `text`.
        let update = parseTelegramUpdate(payload);
        if (update) update = withRichMessageText(update);
        if (!update) {
          await dependencies.repository.complete(claim.updateId, claim.leaseToken);
          pending.shift();
          continue;
        }

        // Application update decisions are durable DB transitions and never enter an Eve session.
        if (
          update.kind === "callback_query" &&
          await dependencies.handleSoftwareUpdateCallback(update.callbackQuery)
        ) {
          await dependencies.repository.complete(claim.updateId, claim.leaseToken);
          pending.shift();
          continue;
        }

        if (claim.voice && update.kind === "message" && shouldTranscribeVoice(update.message, dependencies.botUsername)) {
          const authorized = await dependencies.authorizeVoice(update.message);
          if (authorized) {
            if (!claim.transcript) {
              await dependencies.repository.beginVoiceTranscription(
                claim.updateId,
                claim.leaseToken,
              );
            }
            const transcript =
              claim.transcript ?? (await dependencies.transcribeVoice(claim.voice)).trim();
            if (!transcript) {
              throw new AppError(
                "AGENT_VOICE_TRANSCRIPT_EMPTY",
                "В голосовом сообщении не удалось распознать речь. Запишите его ещё раз",
              );
            }
            if (!claim.transcript) {
              await dependencies.repository.saveVoiceTranscript(
                claim.updateId,
                claim.leaseToken,
                transcript,
              );
            }
            payload = withTranscript(payload, transcript);
            update = parseTelegramUpdate(payload);
            if (update) update = withRichMessageText(update);
            if (!update) {
              throw new AppError(
                "AGENT_TELEGRAM_PAYLOAD_INVALID",
                "Не удалось подготовить голосовое сообщение для обработки",
              );
            }
          }
        }

        const series: LeasedUpdate[] = [{ claim, update }];
        for (const follower of await claimSeriesFollowers(claim, update)) {
          series.push(follower);
          pending.push(follower.claim);
          startHeartbeat(follower.claim);
        }
        if (series.length > 1) {
          console.info(JSON.stringify({
            code: "AGENT_TELEGRAM_SERIES_CLAIMED",
            messages: series.length,
            updateIds: series.map((item) => item.claim.updateId),
          }));
        }
        const tail = series[series.length - 1]!;
        const pendingAfter = tail.update.kind === "message"
          ? pendingMessagesFromPayloads(await dependencies.repository.listPendingAfter({
            afterUpdateId: tail.claim.updateId,
            limit: TELEGRAM_PENDING_MESSAGES_MAX,
            queueId: tail.claim.queueId,
          }))
          : [];
        for (let index = 0; index < series.length; index += 1) {
          const item = series[index]!;
          const last = index === series.length - 1;
          await dispatchLeased(item.claim, item.update, seriesMarker(series, index), last ? pendingAfter : []);
          pending.shift();
        }
      } catch (error) {
        const failure = {
          code: isAppError(error) ? error.code : "AGENT_TELEGRAM_INGRESS_FAILED",
          message: isAppError(error)
            ? error.message
            : "AGENT_TELEGRAM_INGRESS_FAILED: Не удалось обработать сообщение Telegram",
        };
        console.error(
          JSON.stringify({
            code: failure.code,
            error: error instanceof Error ? error.message : String(error),
            updateId: pending[0]?.updateId ?? claim.updateId,
            ...(pending.length > 1 ? { seriesUpdateIds: pending.map((item) => item.updateId) } : {}),
          }),
        );
        for (const leased of pending) {
          await dependencies.repository.fail(leased.updateId, leased.leaseToken, failure);
        }
        throw error;
      } finally {
        heartbeatController.abort();
        await Promise.all(heartbeats);
      }
    }
  }

  function scheduleDrain(context: TelegramDrainContext): void {
    // Each trigger adds at most one loop; a loop ends when no claimable update remains.
    if (activeDrains.size < maxConcurrentDrains) {
      const scheduled: Promise<void> = drain(context.dispatch).finally(() => {
        activeDrains.delete(scheduled);
      });
      activeDrains.add(scheduled);
    }
    for (const running of activeDrains) context.waitUntil(running);
  }

  const handleVerifiedUpdate = async function handleVerifiedUpdate(
    context: TelegramVerifiedUpdateContext,
  ): Promise<Response> {
    const incomingUpdateId = updateId(context.raw);
    const mediaKind = context.update.kind === "message"
      ? classifyTelegramInboundMedia(context.update.message)
      : "none";
    // External media is acknowledged before durable storage, download, transcription, or Eve dispatch.
    if (
      context.update.kind === "message" &&
      mediaKind !== "none" &&
      !await dependencies.acceptMedia(context.update.message, incomingUpdateId, mediaKind)
    ) {
      return new Response("ok");
    }
    const voice = voiceMetadata(context.raw);
    await dependencies.repository.enqueue({
      continuationKey: queueKey(context.update),
      payload: context.raw,
      updateId: incomingUpdateId,
      ...(voice ? { voice } : {}),
    });
    scheduleDrain(context);
    return new Response("ok");
  };

  // The private poller uses the same native dispatcher without creating a synthetic update.
  handleVerifiedUpdate.drain = async (context: TelegramDrainContext): Promise<Response> => {
    scheduleDrain(context);
    return new Response("ok");
  };
  return handleVerifiedUpdate as TelegramDurableIngressHandler;
}

const authorizeTelegramVoice = createTelegramVoiceAuthorizer(telegramRepository);

export const handleTelegramDurableIngress = createTelegramDurableIngress({
  acceptMedia(message, incomingUpdateId, mediaKind) {
    return telegramIngressRepository.acceptMedia({
      chatId: message.chat.id,
      chatType: message.chat.type,
      mediaKind,
      updateId: incomingUpdateId,
    });
  },
  authorizeVoice: authorizeTelegramVoice,
  botUsername: process.env.TELEGRAM_BOT_USERNAME as string,
  handleSoftwareUpdateCallback,
  leaseMilliseconds: TELEGRAM_INGRESS_LEASE_MS,
  repository: telegramIngressRepository,
  transcribeVoice: transcribeTelegramVoice,
});
