/**
 * Person card rendering and the budget.
 *
 * Constructs covered:
 * - A card that does not fit loses its unread records from the end before it is left out; the
 *   first card always stays; the label is cut to 80 characters.
 */
import { describe, expect, it } from "vitest";

import { personCardsBlock, renderPersonCard, type ShownPersonCard } from "./person-card-render.js";

const card = (id: string, fresh: number): ShownPersonCard => ({
  builtAt: new Date("2026-11-21T00:00:00Z"),
  cardId: id,
  cardRef: `pcard_${id.repeat(32)}`,
  freshRecords: Array.from({ length: fresh }, (_, index) => ({
    content: "x".repeat(400),
    memoryRef: `mem_${String(index).repeat(32)}`,
  })),
  sections: {
    communication: [],
    facts: [{ scope: "всегда", sourceRefs: [], text: "Коротко" }],
    interests: [],
    positions: [],
  },
  subjectLabel: "Я".repeat(200),
  subjectTelegramUserId: id,
  version: 1,
});

describe("personCardsBlock", () => {
  it("trims unread records first and keeps the first card", () => {
    const { block, shown } = personCardsBlock([card("1", 5), card("2", 5)], 1_800);
    // The first card keeps what fits of its unread records, the newest ones (they come newest
    // first), the second fits without any.
    expect(shown.map((fitted) => fitted.freshRecords.length)).toEqual([2, 0]);
    expect(shown[0]!.freshRecords).toEqual(card("1", 5).freshRecords.slice(0, 2));
    expect(block!.length).toBeLessThanOrEqual(1_800);
    expect(renderPersonCard(card("3", 0))).not.toContain("Я".repeat(81));
    expect(personCardsBlock([], 1_800)).toEqual({ block: null, shown: [] });
  });
});
