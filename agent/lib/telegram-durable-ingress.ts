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
import {
  parseTelegramUpdate,
  telegramContinuationToken,
  TELEGRAM_HITL_CALLBACK_PREFIX,
} from "eve/channels/telegram";
import { z } from "zod";

import { TELEGRAM_INGRESS_LEASE_MS } from "../config.js";
import { AppError, isAppError } from "./app-error.js";
import { transcribeTelegramVoice } from "./groq-voice-transcription.js";
import { type TelegramIngressRepository } from "./telegram-ingress-contract.js";
import { telegramIngressRepository } from "./telegram-ingress-repository.js";
import {
  classifyTelegramInboundMedia,
  isMessageAddressedToBot,
  type TelegramInboundMediaKind,
} from "./telegram-message-policy.js";
import { createTelegramVoiceAuthorizer } from "./telegram-voice-authorization.js";
import { telegramRepository } from "./telegram-repository.js";
import { handleSoftwareUpdateCallback } from "./software-updates/callback.js";
import { waitForSessionBoundary, type EveSessionResult } from "./telegram-session-boundary.js";

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

interface DurableIngressDependencies {
  acceptMedia(
    message: Pick<TelegramMessage, "chat">,
    updateId: string,
    mediaKind: Exclude<TelegramInboundMediaKind, "none">,
  ): Promise<boolean>;
  authorizeVoice(message: Pick<TelegramMessage, "chat" | "from">): Promise<boolean>;
  botUsername: string;
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

  async function drain(
    dispatch: TelegramVerifiedUpdateContext["dispatch"],
  ): Promise<void> {
    while (true) {
      const claim = await dependencies.repository.claimNext(dependencies.leaseMilliseconds);
      if (!claim) return;
      const heartbeatController = new AbortController();
      let heartbeatError: unknown;
      const heartbeat = maintainLease(
          claim.updateId,
          claim.leaseToken,
          heartbeatController.signal,
        )
        .catch((error: unknown) => {
          heartbeatError = error;
        });
      let dispatchedSessionId: string | undefined;

      try {
        let payload = claim.payload;
        let update = parseTelegramUpdate(payload);
        if (!update) {
          await dependencies.repository.complete(claim.updateId, claim.leaseToken);
          continue;
        }

        // Software updates are application-owned. Native HITL buttons must reach Eve's existing
        // onHitlCallbackQuery guard, which checks the exact pending request and current approver.
        if (update.kind === "callback_query") {
          const claimed = await dependencies.handleSoftwareUpdateCallback(update.callbackQuery);
          const nativeHitl = update.callbackQuery.data?.startsWith(TELEGRAM_HITL_CALLBACK_PREFIX) === true;
          if (claimed || !nativeHitl) {
            if (!claimed) {
              console.error(JSON.stringify({
                code: "AGENT_TELEGRAM_CALLBACK_UNCLAIMED",
                updateId: claim.updateId,
              }));
            }
            await dependencies.repository.complete(claim.updateId, claim.leaseToken);
            continue;
          }
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
            if (!update) {
              throw new AppError(
                "AGENT_TELEGRAM_PAYLOAD_INVALID",
                "Не удалось подготовить голосовое сообщение для обработки",
              );
            }
          }
        }

        await dependencies.repository.beginDispatch(claim.updateId, claim.leaseToken);
        const session = (await dispatch(
          withCaptionlessAttachmentText(update),
        )) as EveSessionResult | null | undefined;
        if (!session) {
          await dependencies.repository.complete(claim.updateId, claim.leaseToken);
          continue;
        }
        dispatchedSessionId = session.id;
        // The durable cursor excludes every event from earlier turns of a reused Eve session.
        const streamCursor = await dependencies.repository.sessionEventStreamCursor(session.id);
        const nextEventIndex = await waitForSessionBoundary(
          session,
          streamCursor,
          dependencies.leaseMilliseconds,
        );
        if (heartbeatError) throw heartbeatError;
        await dependencies.repository.completeWithSession(
          claim.updateId,
          claim.leaseToken,
          session.id,
          nextEventIndex,
        );
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
            updateId: claim.updateId,
          }),
        );
        // The record is terminal, but the rest of the queue is not: a rethrow here left every
        // later message waiting for the next inbound webhook to start a new drain.
        // A lost observer has no trustworthy cursor. Do not reuse that canonical session and
        // accidentally consume its late waiting event as the next message's completion.
        await dependencies.repository.fail(claim.updateId, claim.leaseToken, failure, dispatchedSessionId);
      } finally {
        heartbeatController.abort();
        await heartbeat;
      }
    }
  }

  function scheduleDrain(context: TelegramDrainContext): void {
    // PostgreSQL leases only the first non-terminal item of each queue. Independent drainers
    // let another chat progress while a slow turn runs, without overtaking this chat's head.
    context.waitUntil(drain(context.dispatch));
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
