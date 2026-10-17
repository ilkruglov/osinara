/**
 * Interactive Telegram memory-review turn composition.
 *
 * Exports:
 * - `prepareTelegramMemoryReviewTurn`: binds an unprocessed tail to one ordinary group turn.
 *
 * Key constructs:
 * - Combined participant sources are deduplicated, chronological, and synchronized in bounded chunks.
 */
import { AppError } from "../app-error.js";
import {
  composeTelegramTurnMessage,
  type PreparedTelegramGroupTurnContext,
} from "../telegram-group-turn-context.js";
import {
  renderTelegramGroupJournalContext,
  type TelegramGroupJournalEntry,
} from "../telegram-group-journal-context.js";
import { MEMORY_REVIEW_BATCH_SIZE, MEMORY_REVIEW_INTERACTIVE_TAIL_ENABLED } from "./memory-review-config.js";
import { formatInteractiveMemoryReviewSelection } from "./memory-review-prompt.js";
import type { memoryReviewRepository } from "./memory-review-repository.js";

interface TelegramMemoryReviewTurnDependencies {
  memoryReview: Pick<
    typeof memoryReviewRepository,
    "failInteractivePreparation" | "observePassiveMessage" | "prepareInteractiveTurn"
  >;
  syncParticipants(conversationId: string, entryIds: readonly string[]): Promise<unknown>;
}

function requiredEntryId(entry: TelegramGroupJournalEntry): string {
  if (entry.entryId === undefined) {
    throw new AppError(
      "AGENT_MEMORY_REVIEW_SOURCE_ID_MISSING",
      "Не удалось определить источник сообщения для проверки памяти",
    );
  }
  return entry.entryId;
}

function chronologicalUniqueEntries(
  entries: readonly TelegramGroupJournalEntry[],
  excludedEntryId: string,
): TelegramGroupJournalEntry[] {
  const byEntryId = new Map<string, TelegramGroupJournalEntry>();

  // Ordinary entries are inserted first because their attachment projection already passed the
  // current capability filter. Review overlap can prove identity but cannot broaden that view.
  for (const entry of entries) {
    const entryId = requiredEntryId(entry);
    if (entryId === excludedEntryId) continue;
    const existing = byEntryId.get(entryId);
    if (existing && existing.sequenceId !== entry.sequenceId) {
      throw new AppError(
        "AGENT_MEMORY_REVIEW_SOURCE_SEQUENCE_CONFLICT",
        "Не удалось упорядочить источники для проверки памяти",
      );
    }
    if (!existing) byEntryId.set(entryId, entry);
  }
  return [...byEntryId.values()].sort((left, right) => {
    const sequenceOrder = BigInt(left.sequenceId) < BigInt(right.sequenceId)
      ? -1
      : BigInt(left.sequenceId) > BigInt(right.sequenceId)
        ? 1
        : 0;
    return sequenceOrder || requiredEntryId(left).localeCompare(requiredEntryId(right));
  });
}

/** Combined sources keep chronology across repository boundaries; each query stays within 50 IDs. */
async function syncParticipantsInChunks(
  repositories: TelegramMemoryReviewTurnDependencies,
  conversationId: string,
  entries: readonly TelegramGroupJournalEntry[],
): Promise<void> {
  for (let offset = 0; offset < entries.length; offset += MEMORY_REVIEW_BATCH_SIZE) {
    await repositories.syncParticipants(
      conversationId,
      entries.slice(offset, offset + MEMORY_REVIEW_BATCH_SIZE).map(requiredEntryId),
    );
  }
}

export async function prepareTelegramMemoryReviewTurn(input: {
  applicationSessionId: string;
  conversationId: string;
  currentEntryId: string;
  groupId: string;
  preparedContext: PreparedTelegramGroupTurnContext;
  repositories: TelegramMemoryReviewTurnDependencies;
}): Promise<PreparedTelegramGroupTurnContext> {
  if (!MEMORY_REVIEW_INTERACTIVE_TAIL_ENABLED) {
    // The addressed message waits for the idle review like any other message: observing it keeps
    // the lane alive from the first message of a group (the dispatcher creates lanes only for
    // personal conversations), and the participants of the visible history still resolve, so a
    // `remember` with a sourceSequence from that history is not refused before the review runs.
    await input.repositories.memoryReview.observePassiveMessage({
      groupId: input.groupId,
      timelineEntryId: input.currentEntryId,
    });
    await syncParticipantsInChunks(
      input.repositories,
      input.conversationId,
      chronologicalUniqueEntries(input.preparedContext.visibleTimelineEntries, input.currentEntryId),
    );
    return input.preparedContext;
  }
  const reviewBatch = await input.repositories.memoryReview.prepareInteractiveTurn({
    applicationSessionId: input.applicationSessionId,
    groupId: input.groupId,
    timelineEntryId: input.currentEntryId,
  });

  try {
    const combinedEntries = chronologicalUniqueEntries([
      ...input.preparedContext.visibleTimelineEntries,
      ...(reviewBatch?.entries ?? []),
    ], input.currentEntryId);
    const context = reviewBatch === null
      ? input.preparedContext
      : {
          ...input.preparedContext,
          durableMessage: [
            formatInteractiveMemoryReviewSelection(
              reviewBatch.entries.map((entry) => entry.sequenceId),
            ),
            composeTelegramTurnMessage(
              combinedEntries.length === 0 && input.preparedContext.timelineOmission === null
                ? null
                : renderTelegramGroupJournalContext(
                    combinedEntries,
                    input.preparedContext.timelineOmission,
                    input.preparedContext.timelineTimezone ?? null,
                  ),
              input.preparedContext.currentMessageEnvelope,
              input.preparedContext.handoffBlock ?? null,
            ),
          ].join("\n\n"),
          memoryReviewBatchId: reviewBatch.batchId,
          memoryReviewSourceEntryIds: reviewBatch.sourceEntryIds,
        };

    // The current participant was synchronized before review preparation.
    await syncParticipantsInChunks(input.repositories, input.conversationId, combinedEntries);
    return context;
  } catch (error) {
    if (reviewBatch) {
      await input.repositories.memoryReview.failInteractivePreparation(
        reviewBatch.batchId,
        error instanceof AppError &&
          (error.code === "AGENT_MEMORY_REVIEW_SOURCE_ID_MISSING" ||
            error.code === "AGENT_MEMORY_REVIEW_SOURCE_SEQUENCE_CONFLICT")
          ? "AGENT_MEMORY_REVIEW_CONTEXT_COMPOSITION_FAILED"
          : "AGENT_MEMORY_REVIEW_PARTICIPANT_SYNC_FAILED",
      );
    }
    throw error;
  }
}
