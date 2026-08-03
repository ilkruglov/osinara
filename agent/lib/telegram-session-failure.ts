/**
 * Telegram terminal session failure handling.
 *
 * Export:
 * - `handleTelegramSessionFailure`: ignores ownership conflicts or records and reports a real failure.
 */
import type { TelegramEventContext } from "eve/channels/telegram";

import { formatTelegramSessionFailure } from "./telegram-interface.js";
import { AppError } from "./app-error.js";
import type { SessionEventResult } from "./sessions/session-eve-event.js";
import type { sessionRepository } from "./sessions/session-repository.js";
import { postTelegramMessageWithoutContinuationChange } from "./telegram-stable-delivery.js";

interface SessionFailureData {
  code: string;
  details?: Readonly<Record<string, unknown>>;
  message: string;
  sessionId: string;
}

type SessionFailureRepository = Pick<
  typeof sessionRepository,
  "recordSessionFailedByContinuationToken"
>;

const TELEGRAM_CONTINUATION_NAMESPACE = "telegram";

function rawTelegramContinuationToken(namespacedToken: string): string {
  // Event contexts expose Eve's `<channel>:<raw>` token, while application routes store only raw.
  const separator = namespacedToken.indexOf(":");
  const namespace = namespacedToken.slice(0, separator);
  const rawToken = namespacedToken.slice(separator + 1);
  if (separator <= 0 || namespace !== TELEGRAM_CONTINUATION_NAMESPACE || !rawToken) {
    throw new AppError(
      "AGENT_SESSION_CONTINUATION_INVALID",
      "Не удалось определить маршрут повреждённого Telegram-контекста",
    );
  }
  return rawToken;
}

function isHookConflictFailure(data: SessionFailureData): boolean {
  // Eve serializes unrecognized workflow errors into `details`; accept the exact class identity
  // in either stable code position without classifying arbitrary message text as a conflict.
  return data.code === "HookConflictError" || data.details?.name === "HookConflictError";
}

export async function handleTelegramSessionFailure(
  data: SessionFailureData,
  channel: TelegramEventContext,
  repository: SessionFailureRepository,
): Promise<void> {
  // A competing root loses hook ownership by design; the existing owner is healthy and must not
  // be rotated or shown a terminal failure produced by the rejected competitor.
  if (isHookConflictFailure(data)) return;
  const failedContinuationToken = rawTelegramContinuationToken(channel.continuationToken);
  const result = await repository.recordSessionFailedByContinuationToken(
    failedContinuationToken,
    data.sessionId,
  ) as SessionEventResult;
  if (result === "stale") return;
  await postTelegramMessageWithoutContinuationChange(channel, formatTelegramSessionFailure(data));
}
