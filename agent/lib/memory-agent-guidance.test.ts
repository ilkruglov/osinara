/**
 * Agent memory-guidance regression tests.
 *
 * Constructs covered:
 * - Every mode that can search memory defines bounded context deepening before complex work.
 * - The explicit search tool advertises iterative semantic retrieval to the model.
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
      modeInstructions({
        capabilities: new Set(["search_memories"]),
        environment: "external",
        skills: new Set(),
      }),
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
});
