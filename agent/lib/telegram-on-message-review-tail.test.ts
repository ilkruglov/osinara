/**
 * Group review tail on an addressed turn.
 *
 * Constructs covered:
 * - While the interactive review tail is switched off, an addressed group turn is prepared without
 *   binding the unreviewed tail to it: the tail waits for the idle review lane.
 */
import { describe, expect, it } from "vitest";

import { MEMORY_REVIEW_INTERACTIVE_TAIL_ENABLED } from "./memory-review/memory-review-config.js";
import { createTelegramMessageHandler } from "./telegram-on-message.js";
import { groupMessage, repositories, telegramContext } from "./telegram-on-message.test-fixtures.js";

describe("group review tail on an addressed turn", () => {
  it("leaves the unreviewed tail to the idle review while the interactive path is off", async () => {
    // 17 October 2026, 50 production batches judged blind: the turn reviewed its tail in 4–15 % of
    // cases since September, the dedicated review found twice as much on the same tails.
    expect(MEMORY_REVIEW_INTERACTIVE_TAIL_ENABLED).toBe(false);
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "addressed_only",
      telegramChatId: "group-101",
      toolAllowlist: [],
      type: "family_private",
    });
    repository.telegram.findIdentity.mockResolvedValue({ familyId: "family-1", role: "member", userId: "user-1" });
    repository.session.hasRoute.mockResolvedValue(false);
    repository.hitl.authorizeReply.mockResolvedValue("not_applicable");
    repository.session.prepareTurn.mockResolvedValue({
      continuationToken: "group-101::1:osinara:1",
      generation: 1,
      id: "session-group",
      rotated: false,
      sandboxSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const handler = createTelegramMessageHandler(repository);

    await handler(telegramContext().context, groupMessage("Мия, который час?"));

    expect(repository.session.prepareTurn).toHaveBeenCalled();
    expect(repository.memoryReview.prepareInteractiveTurn).not.toHaveBeenCalled();
    // The addressed message still reaches the lane, so a group of addressed messages is reviewed.
    expect(repository.memoryReview.observePassiveMessage).toHaveBeenCalledWith({
      groupId: "group-1",
      timelineEntryId: "00000000-0000-4000-8000-000000000010",
    });
  });
});
