/**
 * Validation of the model's card.
 *
 * Exports:
 * - `PERSON_CARD_SECTIONS`, `PersonCardSections`, `PersonCardItem`: the card's content.
 * - `parsePersonCardResponse`: maps prompt ids back to records and enforces every rule the model
 *   could break; returns the card and the cited records.
 *
 * Key constructs:
 * - The model is checked, not trusted: an item keeps only sources it was given (episodes only under
 *   positions), an item without one is dropped. Cards no longer clean memory (owner, 23 November
 *   2026): a `cleanup` an older prompt's answer still carries is ignored, and no source of an item
 *   is replaced or dropped for it.
 * - Over the character budget whole items go from the end of the fullest section; the budget
 *   counts the items as the turn renders them, escaping included.
 */
import { z } from "zod";

import { AppError } from "../app-error.js";
import { escapeUntrustedContextJson } from "../untrusted-context-json.js";
import {
  PERSON_CARD_ITEM_MAX_CHARACTERS,
  PERSON_CARD_ITEMS_MAX_CHARACTERS,
  PERSON_CARD_MAX_ITEM_SOURCES,
} from "./person-card-config.js";
import type { PersonCardPromptRecord } from "./person-card-prompt.js";
import type { PersonCardSource } from "./person-card-sources-repository.js";

export const PERSON_CARD_SECTIONS = ["communication", "interests", "facts", "positions"] as const;
export type PersonCardSectionName = (typeof PERSON_CARD_SECTIONS)[number];

export interface PersonCardItem {
  scope: string;
  /** Memory refs of the cited records. */
  sourceRefs: string[];
  text: string;
}

export type PersonCardSections = Record<PersonCardSectionName, PersonCardItem[]>;

export interface ParsedPersonCard {
  characters: number;
  cited: PersonCardSource[];
  droppedItems: number;
  sections: PersonCardSections;
}

// PostgreSQL refuses NUL and an unpaired surrogate in jsonb: one would roll the whole build back.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const cleanText = (limit: number) =>
  z
    .string()
    .transform((value) => value.replaceAll("\u0000", "").replace(LONE_SURROGATE, "\uFFFD").trim())
    .pipe(z.string().min(1).max(limit));
const ITEM = z.object({
  scope: cleanText(120),
  // A stray number or null among the refs is ignored, not the whole item.
  sources: z
    .union([z.string().transform((ref) => [ref]), z.array(z.unknown())])
    .transform((refs) => refs.filter((ref): ref is string => typeof ref === "string"))
    .pipe(z.array(z.string()).min(1)),
  text: cleanText(PERSON_CARD_ITEM_MAX_CHARACTERS),
});
// A missing or null section is an empty one.
const section = z
  .array(z.unknown())
  .nullish()
  .transform((items) => items ?? []);
const RESPONSE = z.object({
  communication: section,
  facts: section,
  interests: section,
  positions: section,
});

function invalid(detail: string): AppError {
  return new AppError(
    "AGENT_PERSON_CARD_RESPONSE_INVALID",
    `Ответ модели не стал карточкой: ${detail}`,
  );
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw invalid("нет JSON");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw invalid("JSON не разбирается");
  }
}

/** As the turn renders the item: escaped JSON, so markup characters count six times. */
function itemCharacters(item: PersonCardItem): number {
  return escapeUntrustedContextJson([item.text, item.scope]).length + 1;
}

function totalCharacters(sections: PersonCardSections): number {
  return PERSON_CARD_SECTIONS.reduce(
    (sum, name) => sum + sections[name].reduce((inner, item) => inner + itemCharacters(item), 0),
    0,
  );
}

function trimToBudget(sections: PersonCardSections): number {
  let dropped = 0;
  // An item too long on its own goes first: trimming from the end would take the short ones.
  for (const name of PERSON_CARD_SECTIONS) {
    const fitting = sections[name].filter(
      (item) => itemCharacters(item) <= PERSON_CARD_ITEMS_MAX_CHARACTERS,
    );
    dropped += sections[name].length - fitting.length;
    sections[name] = fitting;
  }
  while (totalCharacters(sections) > PERSON_CARD_ITEMS_MAX_CHARACTERS) {
    const fullest = PERSON_CARD_SECTIONS.reduce((best, name) =>
      sections[name].length > sections[best].length ? name : best,
    );
    sections[fullest].pop();
    dropped += 1;
  }
  return dropped;
}

export function parsePersonCardResponse(
  text: string,
  records: readonly PersonCardPromptRecord[],
): ParsedPersonCard {
  const response = RESPONSE.safeParse(extractJson(text));
  if (!response.success) throw invalid("неверная форма");
  const byPromptId = new Map(records.map((record) => [record.promptId, record.source]));
  const cited = new Map<string, PersonCardSource>();
  const sections: PersonCardSections = {
    communication: [],
    facts: [],
    interests: [],
    positions: [],
  };
  let droppedItems = 0;
  for (const name of PERSON_CARD_SECTIONS) {
    for (const entry of response.data[name]) {
      const item = ITEM.safeParse(entry);
      const sources = item.success
        ? item.data.sources.flatMap((promptId) => {
            const source = byPromptId.get(promptId);
            if (source === undefined) return [];
            if (source.kind === "episode" && name !== "positions") return [];
            return [source];
          })
        : [];
      if (!item.success || sources.length === 0) {
        droppedItems += 1;
        continue;
      }
      // A trait many records back is the best one: extra valid sources are cut, the item stays.
      const unique = [...new Map(sources.map((source) => [source.id, source])).values()].slice(
        0,
        PERSON_CARD_MAX_ITEM_SOURCES,
      );
      for (const source of unique) cited.set(source.id, source);
      sections[name].push({
        scope: item.data.scope,
        sourceRefs: unique.map((source) => source.memoryRef),
        text: item.data.text,
      });
    }
  }
  droppedItems += trimToBudget(sections);
  // Sources of items cut by the budget are no longer cited.
  const stillCited = new Set(
    PERSON_CARD_SECTIONS.flatMap((name) => sections[name].flatMap((item) => item.sourceRefs)),
  );
  const citedSources = [...cited.values()].filter((source) => stillCited.has(source.memoryRef));
  if (citedSources.length === 0) {
    throw new AppError(
      "AGENT_PERSON_CARD_EMPTY",
      "Модель не собрала ни одного пункта с источником",
    );
  }
  return {
    characters: totalCharacters(sections),
    cited: citedSources,
    droppedItems,
    sections,
  };
}
