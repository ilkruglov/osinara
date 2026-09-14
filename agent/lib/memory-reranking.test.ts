/** Reranking validates complete result indices and never truncates or loses fallback candidates. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { rerankMemories } from "./memory-reranking.js";
import type { ScoredMemoryRetrievalResult } from "./memory-retrieval-ranking.js";

const candidates = ["Анна любит улун", "Анна любит кофе"].map((content, index) => ({
  memory: { content, id: `claim-${index}` }, score: 0.02, retention: 1,
})) as ScoredMemoryRetrievalResult[];
afterEach(() => vi.unstubAllEnvs());

describe("rerankMemories", () => {
  it("orders by pair relevance and removes below-threshold matches", async () => {
    vi.stubEnv("MEMORY_RERANKER_BASE_URL", "http://reranker");
    const fetcher = vi.fn().mockResolvedValue(Response.json([{ index: 1, score: 0.95 }, { index: 0, score: 0.001 }]));
    const result = await rerankMemories("Кто любит кофе?", candidates, fetcher);
    expect(result.results).toEqual([{ ...candidates[1], rerankScore: 0.95 }]);
    expect(result.status).toBe("applied");
    expect(JSON.parse(String(fetcher.mock.calls[0]![1].body))).toMatchObject({
      query: "Кто любит кофе?", texts: candidates.map((row) => row.memory.content), truncate: false,
    });
  });

  it.each([
    [{ index: 0, score: 0.9 }],
    [{ index: 0, score: 0.9 }, { index: 0, score: 0.8 }],
    [{ index: 0, score: 0.9 }, { index: 2, score: 0.8 }],
    [{ index: 0, score: 0.9 }, { index: 1, score: 10 }],
  ])("keeps the hybrid result on an invalid response %j", async (...response) => {
    vi.stubEnv("MEMORY_RERANKER_BASE_URL", "http://reranker");
    const result = await rerankMemories("кофе", candidates, vi.fn().mockResolvedValue(Response.json(response)));
    expect(result).toEqual({ results: candidates, status: "unavailable" });
  });

  it("retains all source text and reports provider errors as degraded search", async () => {
    vi.stubEnv("MEMORY_RERANKER_BASE_URL", "http://reranker");
    const long = [{ ...candidates[0]!, memory: { ...candidates[0]!.memory, content: "а".repeat(4000) } }];
    const fetcher = vi.fn().mockResolvedValue(new Response("too long", { status: 413 }));
    expect((await rerankMemories("кофе", long, fetcher)).results[0]!.memory.content).toHaveLength(4000);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1].body)).truncate).toBe(false);
  });
});
