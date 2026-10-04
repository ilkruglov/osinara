/**
 * Memory embedding chunking.
 *
 * Constructs covered:
 * - Short content is one source-aligned chunk; paragraphs pack into a chunk while they fit and
 *   never overlap across each other.
 * - A paragraph over the cap splits after sentence ends, then clause ends, then words, with an
 *   overlap that starts at a boundary, never inside a word.
 * - Every chunk is exactly its source slice, stays under the cap, keeps whole Unicode characters,
 *   and the chunks cover the text in order; the narrow cap and the query cap do the same.
 */
import { describe, expect, it } from "vitest";

import {
  MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS,
  MEMORY_EMBEDDING_CHUNK_NARROW_MAX_CHARACTERS,
  MEMORY_EMBEDDING_CHUNK_OVERLAP_CHARACTERS,
  MEMORY_EMBEDDING_QUERY_CHUNK_MAX_CHARACTERS,
} from "./memory-config.js";
import { chunkMemoryContent, chunkMemoryQuery, type MemoryEmbeddingChunkText } from "./memory-embedding-chunks.js";

function expectCoverage(content: string, chunks: MemoryEmbeddingChunkText[], maxCharacters: number): void {
  let coveredThrough = 0;
  for (const [index, current] of chunks.entries()) {
    expect(current.chunkIndex).toBe(index);
    expect(current.content).toBe(content.slice(current.startOffset, current.endOffset));
    expect(current.content.length).toBeLessThanOrEqual(maxCharacters);
    expect(current.content).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(current.content).not.toMatch(/^\s|\s$/u);
    // Nothing between two chunks is lost: the next starts at or before the previous end, plus
    // whitespace that both trimmed.
    expect(content.slice(coveredThrough, current.startOffset).trim()).toBe("");
    if (index > 0) expect(current.startOffset).toBeGreaterThan(chunks[index - 1]!.startOffset);
    coveredThrough = Math.max(coveredThrough, current.endOffset);
  }
  expect(content.slice(coveredThrough).trim()).toBe("");
}

const sentence = (index: number) => `Факт номер ${index} относится к семейной истории и был записан летом.`;

describe("chunkMemoryContent", () => {
  it("keeps short content in one source-aligned chunk", () => {
    expect(chunkMemoryContent("  Семья любит поездки в Казань.  ")).toEqual([
      { chunkIndex: 0, content: "Семья любит поездки в Казань.", endOffset: 31, startOffset: 2 },
    ]);
  });

  it("gives every paragraph its own chunk and joins a heading to the paragraph after it", () => {
    const paragraphs = Array.from({ length: 4 }, (_, p) => Array.from({ length: 5 }, (_, s) => sentence(p * 10 + s)).join(" "));
    const content = ["Итог обсуждения 12.09.2026.", ...paragraphs].join("\n\n");
    const chunks = chunkMemoryContent(content);

    expectCoverage(content, chunks, MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS);
    expect(chunks).toHaveLength(4);
    expect(chunks[0]!.content).toBe(`Итог обсуждения 12.09.2026.\n\n${paragraphs[0]}`);
    expect(chunks.slice(1).map((chunk) => chunk.content)).toEqual(paragraphs.slice(1));
  });

  it("splits one long paragraph after sentence ends with an overlap starting at a boundary", () => {
    const content = Array.from({ length: 60 }, (_, index) => sentence(index)).join(" ");
    const chunks = chunkMemoryContent(content);

    expectCoverage(content, chunks, MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS);
    expect(chunks.length).toBeGreaterThan(1);
    for (const [index, chunk] of chunks.entries()) {
      if (index < chunks.length - 1) expect(chunk.content).toMatch(/\.$/u);
      expect(chunk.content).toMatch(/^Факт номер \d+/u);
      if (index > 0) {
        const overlap = chunks[index - 1]!.endOffset - chunk.startOffset;
        expect(overlap).toBeGreaterThan(0);
        expect(overlap).toBeLessThanOrEqual(2 * MEMORY_EMBEDDING_CHUNK_OVERLAP_CHARACTERS);
      }
    }
  });

  it("falls back to clause ends, then words, when a paragraph has no sentence ends", () => {
    const clauses = Array.from({ length: 40 }, (_, index) => `пункт ${index} списка покупок на неделю`).join("; ");
    const clauseChunks = chunkMemoryContent(clauses);
    expectCoverage(clauses, clauseChunks, MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS);
    expect(clauseChunks.length).toBeGreaterThan(1);
    for (const chunk of clauseChunks) expect(chunk.content).toMatch(/^пункт \d+/u);

    const words = Array.from({ length: 300 }, (_, index) => `слово${index}`).join(" ");
    const wordChunks = chunkMemoryContent(words);
    expectCoverage(words, wordChunks, MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS);
    for (const chunk of wordChunks) expect(chunk.content).toMatch(/^слово\d+/u);
  });

  it("honours the narrow cap for text the embedder refused", () => {
    const content = Array.from({ length: 60 }, (_, index) => sentence(index)).join(" ");
    const narrow = chunkMemoryContent(content, { maxCharacters: MEMORY_EMBEDDING_CHUNK_NARROW_MAX_CHARACTERS });
    expectCoverage(content, narrow, MEMORY_EMBEDDING_CHUNK_NARROW_MAX_CHARACTERS);
    expect(narrow.length).toBeGreaterThan(chunkMemoryContent(content).length);
  });

  it.each([
    ["memory", (content: string) => chunkMemoryContent(content), MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS],
    ["query", chunkMemoryQuery, MEMORY_EMBEDDING_QUERY_CHUNK_MAX_CHARACTERS],
  ] as const)("keeps complete Unicode characters at every boundary in %s", (_name, chunk, maxCharacters) => {
    for (const prefix of [0, 1, 119, 120, 399, 400, 499, 500, 999, 1_000]) {
      const content = "а".repeat(prefix) + "😀🧑🏽‍💻".repeat(110) + "б".repeat(900);
      expectCoverage(content, chunk(content), maxCharacters);
    }
  });

  it("rejects empty text", () => {
    expect(() => chunkMemoryContent("   ")).toThrow("AGENT_MEMORY_EMBEDDING_INPUT_INVALID");
  });
});
