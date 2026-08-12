/**
 * Turn-bound Telegram memory source authorization.
 *
 * Exports:
 * - `bindMemoryTurnSources`: persists the immutable source set at `turn.started`.
 * - `resolveMemoryTurnSource`: resolves current, visible-delta, or review-batch source for `remember`.
 * - `releaseMemoryTurnSources`: releases timeline retention at the terminal turn boundary.
 */
import type { SessionContext } from "eve/context";

import { AppError } from "./app-error.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { memoryTurnSourceRepository } from "./memory-turn-source-repository.js";

const POSITIVE_SEQUENCE_PATTERN = /^[1-9]\d*$/u;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

type TurnContext = Pick<SessionContext, "session">;

function sourceError(reason: string): AppError {
  console.error(JSON.stringify({
    code: "AGENT_MEMORY_TURN_SOURCE_INVALID",
    reason,
  }));
  return new AppError(
    "AGENT_MEMORY_EXPLICIT_SOURCE_INVALID",
    "Не удалось подтвердить сообщение для сохранения памяти. Отправьте запрос ещё раз",
  );
}

export async function bindMemoryTurnSources(ctx: TurnContext): Promise<void> {
  const attributes = ctx.session.auth.current?.attributes;
  const applicationSessionId = attributes?.applicationSessionId;
  const conversationId = attributes?.telegramConversationId;
  const currentTimelineEntryId = attributes?.telegramTimelineEntryId;
  const invokingTelegramUserId = attributes?.telegramUserId;
  const memoryReviewBatchId = attributes?.memoryReviewBatchId;
  const memoryReviewSourceEntryIds = attributes?.memoryReviewSourceEntryIds;
  const visibleTimelineEntryIds = attributes?.telegramTimelineVisibleEntryIds;
  const internalReview = memoryReviewBatchId !== undefined && currentTimelineEntryId === undefined;
  const present = [applicationSessionId, conversationId, currentTimelineEntryId,
    invokingTelegramUserId, visibleTimelineEntryIds, memoryReviewBatchId,
    memoryReviewSourceEntryIds].filter((value) => value !== undefined).length;
  if (present === 0) return;
  if (internalReview) {
    if (typeof applicationSessionId !== "string" || typeof conversationId !== "string" ||
      typeof invokingTelegramUserId !== "string" || typeof memoryReviewBatchId !== "string" ||
      !Array.isArray(memoryReviewSourceEntryIds) ||
      !memoryReviewSourceEntryIds.every((entryId) => typeof entryId === "string") ||
      visibleTimelineEntryIds !== undefined) {
      throw sourceError("review_turn_attributes_invalid");
    }
    await memoryTurnSourceRepository.bindReview({
      applicationSessionId,
      conversationId,
      eveSessionId: ctx.session.id,
      eveTurnId: ctx.session.turn.id,
      invokingTelegramUserId,
      memoryReviewBatchId,
      sourceEntryIds: memoryReviewSourceEntryIds,
    });
    return;
  }
  if (typeof applicationSessionId !== "string" || typeof conversationId !== "string" ||
    typeof currentTimelineEntryId !== "string" || typeof invokingTelegramUserId !== "string" ||
    !Array.isArray(visibleTimelineEntryIds) ||
    !visibleTimelineEntryIds.every((entryId) => typeof entryId === "string") ||
    ((memoryReviewBatchId === undefined) !== (memoryReviewSourceEntryIds === undefined)) ||
    (memoryReviewSourceEntryIds !== undefined && (!Array.isArray(memoryReviewSourceEntryIds) ||
      !memoryReviewSourceEntryIds.every((entryId) => typeof entryId === "string")))) {
    throw sourceError("turn_attributes_invalid");
  }
  await memoryTurnSourceRepository.bind({
    applicationSessionId,
    conversationId,
    currentTimelineEntryId,
    eveSessionId: ctx.session.id,
    eveTurnId: ctx.session.turn.id,
    invokingTelegramUserId,
    ...(typeof memoryReviewBatchId === "string" ? { memoryReviewBatchId } : {}),
    ...(Array.isArray(memoryReviewSourceEntryIds) ? {
      memoryReviewSourceEntryIds: memoryReviewSourceEntryIds as string[],
    } : {}),
    visibleTimelineEntryIds,
  });
}

export async function resolveMemoryTurnSource(
  ctx: TurnContext,
  auth: MemoryAuthorization,
  sourceSequence?: string,
): Promise<{
  conversationId: string;
  isCurrent: boolean;
  isReview: boolean;
  messageThreadId: string | null;
  sourceMessageId: string;
  timelineEntryId: string;
}> {
  if (sourceSequence !== undefined && (
    !POSITIVE_SEQUENCE_PATTERN.test(sourceSequence) || BigInt(sourceSequence) > POSTGRES_BIGINT_MAX
  )) {
    throw sourceError("source_sequence_invalid");
  }
  if (sourceSequence !== undefined && auth.groupId === null) {
    throw sourceError("personal_delta_source_forbidden");
  }
  const source = await memoryTurnSourceRepository.resolve({
    eveSessionId: ctx.session.id,
    eveTurnId: ctx.session.turn.id,
    sourceSequence: sourceSequence ?? null,
  });
  if (!source) throw sourceError("source_not_bound_to_turn");
  const expectedPartition = source.scope === "group"
    ? auth.groupId
    : source.scope === "personal"
      ? auth.userId
      : auth.familyId;
  if ((!source.isReview && source.invokingTelegramUserId !== auth.telegramUserId) ||
    source.scopePartitionKey !== expectedPartition || !auth.scopes.includes(source.scope)) {
    throw sourceError("source_authorization_mismatch");
  }
  return {
    conversationId: source.conversationId,
    isCurrent: source.isCurrent,
    isReview: source.isReview,
    messageThreadId: source.messageThreadId,
    sourceMessageId: source.sourceMessageId,
    timelineEntryId: source.timelineEntryId,
  };
}

export async function releaseMemoryTurnSources(ctx: TurnContext): Promise<void> {
  await memoryTurnSourceRepository.release(ctx.session.id, ctx.session.turn.id);
}
