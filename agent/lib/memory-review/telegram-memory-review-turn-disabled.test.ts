/**
 * Addressed group turn while the interactive review tail is switched off.
 *
 * Constructs covered:
 * - The current message is observed for the lane like a passive one, so a group whose every
 *   message addresses the agent still gets a lane and an idle review.
 * - Participants of the visible history are synchronized in bounded chunks, current excluded,
 *   so a `remember` naming one of those sources resolves before the review runs.
 * - No interactive batch is prepared and the prepared context returns unchanged.
 */
import { describe, expect, it, vi } from "vitest";

import type { TelegramGroupJournalEntry } from "../telegram-group-journal-context.js";
import type { PreparedTelegramGroupTurnContext } from "../telegram-group-turn-context.js";
import { MEMORY_REVIEW_INTERACTIVE_TAIL_ENABLED } from "./memory-review-config.js";
import { prepareTelegramMemoryReviewTurn } from "./telegram-memory-review-turn.js";

const id = (sequence: number) => `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;

function entry(sequence: number): TelegramGroupJournalEntry {
  return {
    actorId: `telegram:${sequence}`, actorKind: "user", contentText: `timeline-${sequence}`, entryId: id(sequence),
    messageKind: "text", messageThreadId: null, replyToSequenceId: null, senderDisplayName: `Участник ${sequence}`,
    senderUsername: null, sentAt: `2026-10-18T10:${String(sequence % 60).padStart(2, "0")}:00.000Z`, sequenceId: String(sequence),
  };
}

describe("prepareTelegramMemoryReviewTurn while the interactive tail is off", () => {
  it("observes the current message for the lane, syncs the visible participants and prepares nothing", async () => {
    expect(MEMORY_REVIEW_INTERACTIVE_TAIL_ENABLED).toBe(false);
    const historical = Array.from({ length: 60 }, (_, index) => entry(index + 1));
    const current = 61;
    const preparedContext = {
      cursorSequence: String(current),
      currentMessageEnvelope: "<current_telegram_message>{}</current_telegram_message>",
      durableMessage: "<current_telegram_message>{}</current_telegram_message>",
      omittedBeforeSequence: null,
      timelineOmission: null,
      visibleEntryIds: [...historical.map((e) => e.entryId!), id(current)],
      visibleTimelineEntries: [...historical, entry(current)],
    } as unknown as PreparedTelegramGroupTurnContext;
    const memoryReview = {
      failInteractivePreparation: vi.fn(),
      observePassiveMessage: vi.fn().mockResolvedValue(null),
      prepareInteractiveTurn: vi.fn(),
    };
    const syncParticipants = vi.fn().mockResolvedValue(undefined);

    const result = await prepareTelegramMemoryReviewTurn({
      applicationSessionId: "session-1",
      conversationId: "conversation-1",
      currentEntryId: id(current),
      groupId: "group-1",
      preparedContext,
      repositories: { memoryReview, syncParticipants },
    });

    expect(result).toBe(preparedContext);
    expect(memoryReview.observePassiveMessage).toHaveBeenCalledWith({ groupId: "group-1", timelineEntryId: id(current) });
    expect(memoryReview.prepareInteractiveTurn).not.toHaveBeenCalled();
    const synced = syncParticipants.mock.calls.flatMap(([, ids]) => ids as string[]);
    expect(synced).toEqual(historical.map((e) => e.entryId));
    expect(synced).not.toContain(id(current));
    expect(syncParticipants.mock.calls.map(([, ids]) => (ids as string[]).length)).toEqual([50, 10]);
  });
});
