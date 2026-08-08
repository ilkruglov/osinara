/**
 * Agent memory-guidance regression tests.
 *
 * Constructs covered:
 * - Every mode that can search memory defines bounded context deepening before complex work.
 * - The explicit search tool advertises iterative semantic retrieval to the model.
 * - Similarity never instructs the model to merge or delete durable records.
 */
import { describe, expect, it } from "vitest";

import { modeInstructions } from "./prompt/mode-instructions.js";
import searchMemories from "./tools/search_memories.js";

describe("agent memory guidance", () => {
  it.each([
    ["private", modeInstructions({ environment: "private" })],
    ["family", modeInstructions({ environment: "family" })],
    [
      "external with granted search",
      modeInstructions({ capabilities: new Set(["search_memories"]), environment: "external" }),
    ],
  ] as const)(
    "requires bounded multi-query context deepening in the %s mode",
    (_mode, instructions) => {
      expect(instructions).toContain("## Углубление контекста");
      expect(instructions).toContain("до трёх последовательных вызовов `search_memories`");
      expect(instructions).toContain("с разными смысловыми формулировками");
      expect(instructions).toContain("Остановись раньше");
      expect(instructions).toContain("`glob`, `grep` и `read_file`");
      expect(instructions).toContain("Не повторяй автоматически неудачный вызов");
    },
  );

  it("tells the model to use semantic search iteratively when context is incomplete", () => {
    expect(searchMemories.description).toContain("углубления контекста");
    expect(searchMemories.description).toContain("до трёх раз");
    expect(searchMemories.description).toContain("разными смысловыми формулировками");
    expect(searchMemories.description).toContain("остановись");
  });

  it.each([
    modeInstructions({ environment: "private" }),
    modeInstructions({ environment: "family" }),
    modeInstructions({
      capabilities: new Set(["search_memories", "manage_memory.delete"]),
      environment: "external",
    }),
  ])("forbids destructive deduplication by similarity", (instructions) => {
    expect(instructions).toContain("Схлопывание точных дубликатов допустимо только сервером при чтении");
    expect(instructions).toContain("не изменяет хранимые записи");
    expect(instructions).toContain("не объединяй и не удаляй записи только из-за похожести");
    expect(instructions).not.toContain("остальные удали");
  });
});
