/** Local pairwise relevance scoring after hybrid retrieval, before the final live authorization. */
import { AppError } from "./app-error.js";
import type { ScoredMemoryRetrievalResult } from "./memory-retrieval-ranking.js";
import { retentionRankFactor } from "./memory-retention-score.js";

export const MEMORY_RERANKING_MIN_SCORE = 0.05;
const TIMEOUT_MILLISECONDS = 2_000;

export async function rerankMemories(
  query: string,
  candidates: ScoredMemoryRetrievalResult[],
  fetcher: typeof fetch = fetch,
  includeWeakMatches = false,
): Promise<{ results: ScoredMemoryRetrievalResult[]; status: "applied" | "disabled" | "unavailable" }> {
  const rawUrl = process.env.MEMORY_RERANKER_BASE_URL;
  if (!rawUrl || candidates.length === 0) return { results: candidates, status: "disabled" };
  const base = new URL(rawUrl);
  if (!["http:", "https:"].includes(base.protocol)) {
    throw new AppError("AGENT_MEMORY_RERANKER_CONFIG_INVALID", "Неверный адрес локальной проверки памяти");
  }
  const started = performance.now();
  try {
    const response = await fetcher(new URL("/rerank", base.origin), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, texts: candidates.map((row) => row.memory.content), truncate: false }),
      signal: AbortSignal.timeout(TIMEOUT_MILLISECONDS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (!Array.isArray(payload) || payload.length !== candidates.length) throw new Error("Incomplete scores");
    const indices = new Set<number>();
    const scores = payload.map((item: unknown) => {
      if (!item || typeof item !== "object" || !("index" in item) || !("score" in item)) throw new Error("Invalid score");
      const { index, score } = item;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= candidates.length ||
        indices.has(index) || typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) throw new Error("Invalid score");
      indices.add(index);
      return { index, score };
    });
    const results = scores.filter((item) => includeWeakMatches || item.score >= MEMORY_RERANKING_MIN_SCORE)
      .sort((a, b) => b.score * retentionRankFactor(candidates[b.index]!.retention) -
        a.score * retentionRankFactor(candidates[a.index]!.retention) || a.index - b.index)
      .map((item) => ({ ...candidates[item.index]!, rerankScore: item.score }));
    console.info(JSON.stringify({ code: "AGENT_MEMORY_RERANKED", candidates: candidates.length,
      retained: results.length, durationMs: Math.round(performance.now() - started) }));
    return { results, status: "applied" };
  } catch (error) {
    // Provider/token-limit failures keep the whole hybrid result; no silent input truncation.
    console.warn(JSON.stringify({ code: "AGENT_MEMORY_RERANKING_UNAVAILABLE", error: String(error) }));
    return { results: candidates, status: "unavailable" };
  }
}
