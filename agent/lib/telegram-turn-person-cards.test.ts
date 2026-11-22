/**
 * Person cards in the Telegram turn memory context.
 *
 * Constructs covered:
 * - The author's card comes first in every turn with what it did not read, and the author's
 *   unread records are not suppressed as "shown recently"; the profile block learns the cards'
 *   read set and the budget left; the card and fresh refs count as shown.
 * - The cards stay within the profile block's budget, the author's first; a block that fills it
 *   exactly, frame and line breaks included, keeps every card.
 * - The switch shows the block as before; a card read failure does not fail the turn.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  personCardsBlock,
  renderPersonCard,
  type ShownPersonCard,
} from "./person-cards/person-card-render.js";
import { PROFILE_CONTEXT_MAX_CHARACTERS } from "./memory-config.js";
import { createTelegramMemoryContextBuilder } from "./telegram-turn-memory-context.js";

const access = {
  familyId: "family-1",
  groupId: null,
  memoryScopes: ["personal", "family"] as Array<"family" | "group" | "personal">,
  role: "owner" as const,
  userId: "user-1",
};

function input(
  overrides: Partial<Parameters<ReturnType<typeof createTelegramMemoryContextBuilder>>[0]> = {},
) {
  return {
    access,
    actor: { id: "101", kind: "telegram_user" as const },
    applicationSessionId: "app-session-1",
    conversationId: "conversation-1",
    explicitMentionTelegramUserIds: [],
    query: "что купить?",
    replyTelegramUserId: null,
    replyTimelineSequence: null,
    timelineEntryId: "entry-1",
    turnStartedAt: new Date("2026-08-08T10:00:00.000Z"),
    ...overrides,
  };
}

const emptyRetrieval = {
  memories: [],
  retrievedClaimIds: [],
  threads: { threads: [], totalCharacters: 0 },
};

describe("person cards in the turn", () => {
  const card: ShownPersonCard = {
    builtAt: new Date("2026-11-21T10:00:00.000Z"),
    cardId: "card-1",
    cardRef: `pcard_${"b".repeat(32)}`,
    freshRecords: [{ content: "Купил E39", memoryRef: `mem_${"f".repeat(32)}` }],
    sections: {
      communication: [{ scope: "всегда", sourceRefs: ["mem_1"], text: "Любит короткие ответы" }],
      facts: [{ scope: "всегда", sourceRefs: ["mem_2"], text: "Ездит на E60" }],
      interests: [],
      positions: [],
    },
    subjectLabel: "Илья (ilya_k)",
    subjectTelegramUserId: "101",
    version: 3,
  };
  const exposures = () => ({
    authorCardShownRecently: vi.fn().mockResolvedValue(true),
    recentlyShownMemoryRefs: vi.fn().mockResolvedValue(new Set<string>()),
    record: vi.fn().mockResolvedValue(undefined),
    sessionTurn: vi.fn().mockResolvedValue(7),
  });

  afterEach(() => vi.unstubAllEnvs());

  it("shows the author's card first in every turn, with what is newer, and tells the profile block its read set", async () => {
    const ledger = exposures();
    const loadPersonCards = vi.fn().mockResolvedValue([card]);
    const createProfile = vi.fn().mockResolvedValue(null);
    const build = createTelegramMemoryContextBuilder({
      createProfile,
      exposures: ledger,
      loadPersonCards,
      retrieve: vi.fn().mockResolvedValue({ ...emptyRetrieval, retrievedClaimIds: ["claim-9"] }),
    });

    const blocks = await build(
      input({ explicitMentionTelegramUserIds: ["303"], replyTelegramUserId: "202" }),
    );

    expect(loadPersonCards.mock.calls[0]![1]).toEqual({
      conversationId: "conversation-1",
      replyTimelineSequence: null,
      retrievalClaimIds: ["claim-9"],
      telegramUserIds: ["101", "202", "303"],
    });
    expect(blocks[0]).toMatch(/^<person_cards>/u);
    expect(blocks[0]).toContain("Любит короткие ответы");
    expect(blocks[0]).toContain(card.cardRef);
    expect(blocks[0]).toContain("Купил E39");
    // The author has a card: their unread records are not suppressed as "shown recently".
    expect(ledger.authorCardShownRecently).not.toHaveBeenCalled();
    expect(createProfile.mock.calls[0]![1]).toMatchObject({
      personCardIds: ["card-1"],
      suppressCurrentAuthor: false,
    });
    expect(ledger.record).toHaveBeenCalledWith(
      expect.objectContaining({ memoryRefs: [card.cardRef, `mem_${"f".repeat(32)}`] }),
    );
    expect(blocks.join("\n")).toContain("<memory-used>");
  });

  it("keeps the cards within the profile block's budget, the author's first", async () => {
    const full = (id: string, mark: string): ShownPersonCard => ({
      ...card,
      cardId: `card-${id}`,
      cardRef: `pcard_${mark.repeat(32)}`,
      freshRecords: [],
      sections: {
        communication: [],
        facts: Array.from({ length: 5 }, () => ({
          scope: "всегда",
          sourceRefs: [],
          text: "<".repeat(280),
        })),
        interests: [],
        positions: [],
      },
      subjectTelegramUserId: id,
    });
    const createProfile = vi.fn().mockResolvedValue(null);
    const build = createTelegramMemoryContextBuilder({
      createProfile,
      exposures: exposures(),
      loadPersonCards: vi
        .fn()
        .mockResolvedValue([full("101", "1"), full("202", "2"), full("303", "3")]),
      retrieve: vi.fn().mockResolvedValue(emptyRetrieval),
    });
    const blocks = await build(input());
    const cardsBlock = blocks.find((block) => block.startsWith("<person_cards>"))!;
    // One escaped card is over 8 000 characters: only the author's is shown.
    expect(cardsBlock).toContain(`pcard_${"1".repeat(32)}`);
    expect(cardsBlock).not.toContain(`pcard_${"2".repeat(32)}`);
    expect(createProfile.mock.calls[0]![1].personCardIds).toEqual(["card-101"]);
  });

  it("keeps the whole cards block, frame included, within 6 000 and gives the rest to the profile", async () => {
    const realistic = (id: string): ShownPersonCard => ({
      ...card,
      cardId: `card-${id}`,
      cardRef: `pcard_${id.repeat(32)}`,
      freshRecords: Array.from({ length: 5 }, (_, index) => ({
        content: "<".repeat(450),
        memoryRef: `mem_${String(index).repeat(32)}`,
      })),
      sections: {
        communication: [],
        // Within the build's own limit: 1 250 rendered characters of items.
        facts: Array.from({ length: 4 }, () => ({
          scope: "всегда",
          sourceRefs: [],
          text: "<".repeat(45),
        })),
        interests: [],
        positions: [],
      },
      subjectLabel: "<".repeat(200),
      subjectTelegramUserId: id,
    });
    const createProfile = vi.fn().mockResolvedValue(null);
    const build = createTelegramMemoryContextBuilder({
      createProfile,
      exposures: exposures(),
      loadPersonCards: vi.fn().mockResolvedValue(["1", "2", "3", "4"].map((id) => realistic(id))),
      retrieve: vi.fn().mockResolvedValue(emptyRetrieval),
    });
    const blocks = await build(input());
    const cardsBlock = blocks.find((block) => block.startsWith("<person_cards>"))!;
    expect(cardsBlock.length).toBeLessThanOrEqual(6_000);
    expect(createProfile.mock.calls[0]![1].maxCharacters).toBe(6_000 - cardsBlock.length);
  });

  it("shows every card of a block that fills the budget exactly, line breaks counted", async () => {
    const sized = (id: string, characters: number): ShownPersonCard => {
      const withText = (text: string): ShownPersonCard => ({
        ...card,
        cardId: `card-${id}`,
        cardRef: `pcard_${id.repeat(32)}`,
        freshRecords: [],
        sections: {
          communication: [],
          facts: [{ scope: "всегда", sourceRefs: [], text }],
          interests: [],
          positions: [],
        },
        subjectTelegramUserId: id,
      });
      return withText("ж".repeat(characters - renderPersonCard(withText("")).length));
    };
    const frame =
      personCardsBlock([card], Number.POSITIVE_INFINITY).block!.length -
      renderPersonCard(card).length;
    // The profile block's calls for a turn showing `cards`.
    const run = async (cards: ShownPersonCard[]) => {
      const createProfile = vi.fn().mockResolvedValue(null);
      const blocks = await createTelegramMemoryContextBuilder({
        createProfile,
        exposures: exposures(),
        loadPersonCards: vi.fn().mockResolvedValue(cards),
        retrieve: vi.fn().mockResolvedValue(emptyRetrieval),
      })(input());
      return {
        cardsBlock: blocks.find((block) => block.startsWith("<person_cards>"))!,
        profile: createProfile.mock.calls[0]![1],
      };
    };
    for (const count of [2, 3, 4]) {
      const room = PROFILE_CONTEXT_MAX_CHARACTERS - frame - (count - 1);
      const each = Math.floor(room / count);
      const last = room - each * (count - 1);
      const first = Array.from({ length: count - 1 }, (_, index) => sized(String(index + 1), each));
      const cards = [...first, sized(String(count), last)];
      const exact = await run(cards);
      expect(exact.cardsBlock.length).toBe(PROFILE_CONTEXT_MAX_CHARACTERS);
      expect(exact.profile).toMatchObject({
        maxCharacters: 0,
        personCardIds: cards.map((shown) => shown.cardId),
      });
      // One character more and the last card no longer fits.
      const over = await run([...first, sized(String(count), last + 1)]);
      expect(over.profile.personCardIds).toEqual(first.map((shown) => shown.cardId));
    }
  });

  it("shows no cards and the profile block as before when switched off", async () => {
    vi.stubEnv("AGENT_PERSON_CARDS_ENABLED", "false");
    const loadPersonCards = vi.fn().mockResolvedValue([card]);
    const createProfile = vi.fn().mockResolvedValue(null);
    const build = createTelegramMemoryContextBuilder({
      createProfile,
      exposures: exposures(),
      loadPersonCards,
      retrieve: vi.fn().mockResolvedValue(emptyRetrieval),
    });
    const blocks = await build(input());
    expect(loadPersonCards).not.toHaveBeenCalled();
    expect(blocks.join("\n")).not.toContain("<person_cards>");
    expect(createProfile.mock.calls[0]![1]).toMatchObject({
      maxCharacters: 6_000,
      personCardIds: [],
    });
  });

  it("keeps the turn when cards cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const build = createTelegramMemoryContextBuilder({
      createProfile: vi.fn().mockResolvedValue(null),
      loadPersonCards: vi.fn().mockRejectedValue(new Error("cards unavailable")),
      retrieve: vi.fn().mockResolvedValue({
        ...emptyRetrieval,
        memories: [{ content: "Любит гречку", memoryRef: "mem_1" }],
      }),
    });
    const blocks = await build(input());
    expect(blocks.join("\n")).toContain("Любит гречку");
    expect(blocks.join("\n")).not.toContain("<person_cards>");
  });
});
