/**
 * The prompt of a card build.
 *
 * Coverage:
 * - A record carries whose words it is: the person's told in their turn (`self: "direct"`), the
 *   person's taken down from the chat (`self: "review"`), or someone else's (no `self`) with its
 *   evidence and author (owner, 23 November 2026). A record of the person's own words carries no
 *   author: a record someone reported and the person confirmed named the reporter beside
 *   `self: "direct"` (review of the fixes). The wording of the rules is read, not tested.
 */
import { describe, expect, it } from "vitest";

import { buildPersonCardPrompt, numberPersonCardRecords } from "./person-card-prompt.js";
import type { PersonCardSource } from "./person-card-sources-repository.js";

function source(id: string, overrides: Partial<PersonCardSource>): PersonCardSource {
  return {
    attribute: null,
    authorLabel: null,
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
    selfDirect: false,
    selfStatement: false,
    version: "2026-11-01 10:00:00+00",
    ...overrides,
  };
}

describe("buildPersonCardPrompt", () => {
  it("marks whose words each record is and ranks them", () => {
    const { prompt } = buildPersonCardPrompt({
      area: "group",
      records: numberPersonCardRecords(
        [
          source("1", {
            authorLabel: "Лёша",
            evidenceKind: "reported",
            selfDirect: true,
            selfStatement: true,
          }),
          source("2", { selfStatement: true }),
          source("3", { authorLabel: "Лёша", evidenceKind: "reported" }),
        ],
        [],
      ),
      subjectLabel: "Юра (yura_k)",
    });
    const lines = prompt
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as { author?: string; evidence?: string; self?: string });
    expect(lines.map(({ author, evidence, self }) => ({ author, evidence, self }))).toEqual([
      { author: undefined, evidence: undefined, self: "direct" },
      { author: undefined, evidence: undefined, self: "review" },
      { author: "Лёша", evidence: "reported", self: undefined },
    ]);
  });
});
