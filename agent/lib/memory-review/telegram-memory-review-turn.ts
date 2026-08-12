/**
 * Interactive Telegram memory-review turn composition.
 *
 * Export:
 * - `prepareTelegramMemoryReviewTurn`: binds an unprocessed tail to one ordinary group turn.
 */
import type { PreparedTelegramGroupTurnContext } from "../telegram-group-turn-context.js";
import { formatMemoryReviewBatchPrompt } from "./memory-review-prompt.js";
import type { memoryReviewRepository } from "./memory-review-repository.js";

interface TelegramMemoryReviewTurnDependencies {
  memoryReview: Pick<
    typeof memoryReviewRepository,
    "failInteractivePreparation" | "prepareInteractiveTurn"
  >;
  syncParticipants(conversationId: string, entryIds: readonly string[]): Promise<unknown>;
}

export async function prepareTelegramMemoryReviewTurn(input: {
  applicationSessionId: string;
  conversationId: string;
  currentEntryId: string;
  groupId: string;
  preparedContext: PreparedTelegramGroupTurnContext;
  repositories: TelegramMemoryReviewTurnDependencies;
}): Promise<PreparedTelegramGroupTurnContext> {
  const reviewBatch = await input.repositories.memoryReview.prepareInteractiveTurn({
    applicationSessionId: input.applicationSessionId,
    groupId: input.groupId,
    timelineEntryId: input.currentEntryId,
  });
  const extraReviewEntries = reviewBatch?.entries.filter((entry) =>
    entry.entryId !== input.currentEntryId &&
    !input.preparedContext.visibleEntryIds.includes(entry.entryId ?? "")
  ) ?? [];
  const context = reviewBatch === null
    ? input.preparedContext
    : {
        ...input.preparedContext,
        durableMessage: extraReviewEntries.length === 0
          ? input.preparedContext.durableMessage
          : [
              formatMemoryReviewBatchPrompt(extraReviewEntries),
              input.preparedContext.durableMessage,
            ].join("\n\n"),
        memoryReviewBatchId: reviewBatch.batchId,
        memoryReviewSourceEntryIds: reviewBatch.sourceEntryIds,
      };

  try {
    // Every passive source author must exist before it can become family or group evidence.
    await input.repositories.syncParticipants(input.conversationId, [...new Set([
      ...context.visibleEntryIds,
      ...(context.memoryReviewSourceEntryIds ?? []),
    ])]);
  } catch (error) {
    if (reviewBatch) {
      await input.repositories.memoryReview.failInteractivePreparation(
        reviewBatch.batchId,
        "AGENT_MEMORY_REVIEW_PARTICIPANT_SYNC_FAILED",
      );
    }
    throw error;
  }
  return context;
}
