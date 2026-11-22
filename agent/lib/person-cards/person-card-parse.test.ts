/**
 * Person card response validation tests.
 *
 * Constructs covered:
 * - Items keep only given sources; episodes count only under positions; sourceless items drop.
 * - Cleanup entries are refused for protected records, other partitions, chains and for removing
 *   the person's own words in favour of someone else's; a cleaned record is not cited: an item
 *   citing a repeat cites its kept record, one citing a refuted record loses it.
 * - The character budget counts escaped text and drops whole items; an empty card and a non-JSON
 *   answer fail.
 * - "Refuted" needs the kept record to be newer; NUL characters are dropped and lone surrogates
 *   repaired; extra sources are cut after the invalid ones, not the item; an item too long on its
 *   own does not take the short ones with it.
 */
import { describe, expect, it } from "vitest";

import { PERSON_CARD_ITEMS_MAX_CHARACTERS } from "./person-card-config.js";
import { parsePersonCardResponse } from "./person-card-parse.js";
import { numberPersonCardRecords } from "./person-card-prompt.js";
import type { PersonCardSource } from "./person-card-sources-repository.js";

function source(id: string, overrides: Partial<PersonCardSource> = {}): PersonCardSource {
  return {
    attribute: null,
    authorLabel: "Юрий (yura_k)",
    cleanable: true,
    content: `запись ${id}`,
    createdAt: new Date("2026-11-01T10:00:00Z"),
    evidenceKind: "firsthand",
    id,
    kind: "preference",
    link: "label",
    memoryRef: `mem_${id.padStart(32, "0")}`,
    occurredAt: null,
    scope: "group",
    scopePartitionKey: "group-a",
    selfStatement: false,
    version: "2026-11-01 10:00:00.123456+00",
    ...overrides,
  };
}

const records = numberPersonCardRecords(
  [
    source("1"),
    source("2"),
    source("3", { selfStatement: true }),
    source("4", { cleanable: false }),
    source("5", { scopePartitionKey: "group-b" }),
  ],
  [source("9", { kind: "episode", cleanable: false })],
);

function card(body: Record<string, unknown>): string {
  return `Вот карточка:\n${JSON.stringify(body)}`;
}

describe("parsePersonCardResponse", () => {
  it("keeps given sources, episodes only under positions, and drops sourceless items", () => {
    const parsed = parsePersonCardResponse(
      card({
        communication: [
          { text: "Любит короткие ответы", scope: "всегда", sources: ["r1", "r1", "r77"] },
          { text: "Без источника", scope: "всегда", sources: ["r99"] },
          { text: "Эпизод не годится сюда", scope: "всегда", sources: ["e1"] },
        ],
        positions: [{ text: "Против турбин", scope: "в спорах о моторах", sources: ["e1", "r2"] }],
      }),
      records,
    );
    expect(parsed.sections.communication).toEqual([
      {
        scope: "всегда",
        sourceRefs: [records[0]!.source.memoryRef],
        text: "Любит короткие ответы",
      },
    ]);
    expect(parsed.sections.positions[0]!.sourceRefs).toEqual([
      records[5]!.source.memoryRef,
      records[1]!.source.memoryRef,
    ]);
    expect(parsed.droppedItems).toBe(2);
    expect(parsed.cited.map((cited) => cited.id).sort()).toEqual(["1", "2", "9"]);
  });

  it("refuses unsafe cleanup and never cites a cleaned record", () => {
    const parsed = parsePersonCardResponse(
      card({
        facts: [{ text: "Ездит на E60", scope: "всегда", sources: ["r1", "r2"] }],
        cleanup: [
          { record: "r1", kind: "duplicate", keep: "r2", reason: "то же самое" },
          { record: "r4", kind: "duplicate", keep: "r2", reason: "защищена" },
          { record: "r5", kind: "duplicate", keep: "r2", reason: "другая группа" },
          { record: "r3", kind: "refuted", keep: "r2", reason: "его слова против чужих" },
          { record: "e1", kind: "duplicate", keep: "r2", reason: "эпизод" },
          { record: "r2", kind: "duplicate", keep: "r2", reason: "сам на себя" },
        ],
      }),
      records,
    );
    expect(parsed.cleanup).toEqual([
      {
        explanation: "то же самое",
        keptMemoryItemId: "2",
        memoryItemId: "1",
        reason: "duplicate",
        readVersion: records[0]!.source.version,
      },
    ]);
    expect(parsed.droppedCleanup).toBe(5);
    expect(parsed.sections.facts[0]!.sourceRefs).toEqual([records[1]!.source.memoryRef]);
  });

  it("moves an item citing a repeat to its kept record and drops one citing a refuted one", () => {
    const dated = numberPersonCardRecords(
      [
        source("1"),
        source("2", { createdAt: new Date("2026-11-02T10:00:00Z") }),
        source("3"),
        source("4", { createdAt: new Date("2026-11-03T10:00:00Z") }),
      ],
      [],
    );
    const parsed = parsePersonCardResponse(
      card({
        facts: [
          { text: "Пьёт эспрессо", scope: "всегда", sources: ["r1"] },
          { text: "Живёт в Москве", scope: "всегда", sources: ["r3"] },
          { text: "Живёт в Казани", scope: "всегда", sources: ["r4"] },
        ],
        cleanup: [
          { record: "r1", kind: "duplicate", keep: "r2", reason: "повтор" },
          { record: "r3", kind: "refuted", keep: "r4", reason: "переехал" },
        ],
      }),
      dated,
    );
    // The kept record is the same fact and the card read it: without the move the fact would
    // leave both the card and the profile block.
    expect(parsed.sections.facts).toEqual([
      { scope: "всегда", sourceRefs: [dated[1]!.source.memoryRef], text: "Пьёт эспрессо" },
      { scope: "всегда", sourceRefs: [dated[3]!.source.memoryRef], text: "Живёт в Казани" },
    ]);
    expect(parsed.cited.map((cited) => cited.id).sort()).toEqual(["2", "4"]);
  });

  it("drops a cleanup whose kept record is removed too", () => {
    const parsed = parsePersonCardResponse(
      card({
        facts: [{ text: "Факт", scope: "всегда", sources: ["r1"] }],
        cleanup: [
          { record: "r1", kind: "duplicate", keep: "r2", reason: "повтор" },
          { record: "r2", kind: "duplicate", keep: "r3", reason: "повтор" },
        ],
      }),
      records,
    );
    expect(parsed.cleanup.map((entry) => entry.memoryItemId)).toEqual(["2"]);
    expect(parsed.sections.facts).toHaveLength(1);
  });

  it("keeps the card within the character budget by dropping whole items", () => {
    const long = "ж".repeat(280);
    const parsed = parsePersonCardResponse(
      card({
        facts: Array.from({ length: 8 }, () => ({ text: long, scope: "всегда", sources: ["r1"] })),
        interests: [{ text: "Музыка", scope: "всегда", sources: ["r2"] }],
      }),
      records,
    );
    expect(parsed.characters).toBeLessThanOrEqual(PERSON_CARD_ITEMS_MAX_CHARACTERS);
    expect(parsed.sections.interests).toHaveLength(1);
    expect(parsed.sections.facts.length).toBeLessThan(8);
  });

  it("lets only a newer record refute an older one", () => {
    const dated = numberPersonCardRecords(
      [
        source("10", { createdAt: new Date("2026-01-01T00:00:00Z") }),
        source("11", { createdAt: new Date("2026-11-01T00:00:00Z") }),
      ],
      [],
    );
    const parsed = parsePersonCardResponse(
      card({
        facts: [{ text: "Живёт в Казани", scope: "всегда", sources: ["r2"] }],
        cleanup: [
          { record: "r2", kind: "refuted", keep: "r1", reason: "старое опровергает новое" },
          { record: "r1", kind: "refuted", keep: "r2", reason: "переехал" },
        ],
      }),
      dated,
    );
    expect(parsed.cleanup.map((entry) => [entry.memoryItemId, entry.keptMemoryItemId])).toEqual([
      ["10", "11"],
    ]);
  });

  it("counts escaped text, drops NUL characters and cuts extra sources", () => {
    const markup = parsePersonCardResponse(
      card({
        facts: Array.from({ length: 5 }, () => ({
          text: "<".repeat(150),
          scope: "всегда",
          sources: ["r1"],
        })),
      }),
      records,
    );
    // 150 markup characters render as 900: one such item fits the card, five do not.
    expect(markup.sections.facts).toHaveLength(1);
    expect(markup.characters).toBeLessThanOrEqual(PERSON_CARD_ITEMS_MAX_CHARACTERS);
    const parsed = parsePersonCardResponse(
      card({
        facts: [
          {
            text: "Ездит\u0000 на E60",
            scope: "всегда",
            sources: ["r1", "r2", "r3", "r1", "r2", "r3", "r1", "r2", "r3", "r1", "r2", "r3", "r1"],
          },
        ],
      }),
      records,
    );
    expect(parsed.sections.facts).toEqual([
      {
        scope: "всегда",
        sourceRefs: [
          records[0]!.source.memoryRef,
          records[1]!.source.memoryRef,
          records[2]!.source.memoryRef,
        ],
        text: "Ездит на E60",
      },
    ]);
  });

  it("repairs lone surrogates, keeps a valid source past invalid ones, keeps short items", () => {
    const parsed = parsePersonCardResponse(
      card({
        facts: [
          {
            text: "Любит \ud83d",
            scope: "всегда",
            sources: [
              "e1",
              "e1",
              "x1",
              "x2",
              "x3",
              "x4",
              "x5",
              "x6",
              "x7",
              "x8",
              "x9",
              "x10",
              "x11",
              "r2",
            ],
          },
          { text: "<".repeat(240), scope: "всегда", sources: ["r1"] },
          { text: "Коротко", scope: "всегда", sources: ["r3"] },
        ],
      }),
      records,
    );
    expect(parsed.sections.facts.map((item) => [item.text, item.sourceRefs])).toEqual([
      ["Любит \uFFFD", [records[1]!.source.memoryRef]],
      ["Коротко", [records[2]!.source.memoryRef]],
    ]);
  });

  it("ignores a stray number or null among the refs", () => {
    const parsed = parsePersonCardResponse(
      card({ facts: [{ text: "Факт", scope: "всегда", sources: [777, null, "r1"] }] }),
      records,
    );
    expect(parsed.sections.facts[0]!.sourceRefs).toEqual([records[0]!.source.memoryRef]);
  });

  it("reads a null section as empty and a single string as one source", () => {
    const parsed = parsePersonCardResponse(
      card({
        cleanup: null,
        facts: [{ text: "Факт", scope: "всегда", sources: "r1" }],
        interests: null,
        positions: null,
      }),
      records,
    );
    expect(parsed.sections.facts[0]!.sourceRefs).toEqual([records[0]!.source.memoryRef]);
    expect(parsed.cleanup).toEqual([]);
  });

  it("fails on an empty card and on an answer without JSON", () => {
    expect(() => parsePersonCardResponse(card({ facts: [] }), records)).toThrow(
      expect.objectContaining({ code: "AGENT_PERSON_CARD_EMPTY" }),
    );
    expect(() => parsePersonCardResponse("не могу", records)).toThrow(
      expect.objectContaining({ code: "AGENT_PERSON_CARD_RESPONSE_INVALID" }),
    );
  });
});
