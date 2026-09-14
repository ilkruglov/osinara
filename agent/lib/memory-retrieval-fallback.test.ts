/** Hybrid retrieval degrades only on embedder dependency failures, retaining authorization. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "./app-error.js";
import type { MemoryAuthorization } from "./memory-context.js";
import * as embeddings from "./memory-embedding-client.js";
import { memoryRetrievalRepository } from "./memory-retrieval-repository.js";
import { memoryThreadBriefRepository } from "./memory-thread-brief-repository.js";
import { retrieveRelevantMemories, retrieveMemoryTurnContext } from "./memory-retrieval.js";

const auth = { familyId: "family", scopes: ["personal"], userId: "user" } as MemoryAuthorization;
const empty = { conflicts: [], relatedClaimIds: [], results: [] };
afterEach(() => vi.restoreAllMocks());

describe("hybrid retrieval degradation", () => {
  it.each(["AGENT_MEMORY_EMBEDDING_PROVIDER_UNAVAILABLE", "AGENT_MEMORY_EMBEDDING_PROVIDER_FAILED", "AGENT_MEMORY_EMBEDDING_RESPONSE_INVALID"])("keeps lexical search on %s", async (code) => {
    vi.spyOn(embeddings, "embedMemoryQuery").mockRejectedValue(new AppError(code, "unavailable"));
    const search = vi.spyOn(memoryRetrievalRepository, "searchWithConflictClosure").mockResolvedValue(empty);
    await retrieveRelevantMemories(auth, "термометр", undefined, { occurredAfter: "2026-09-01" });
    expect(search).toHaveBeenCalledWith(auth, "термометр", null, 12, { occurredAfter: "2026-09-01" });
  });

  it("retains claim-based thread activation without an embedding", async () => {
    vi.spyOn(embeddings, "embedMemoryQuery").mockRejectedValue(new AppError("AGENT_MEMORY_EMBEDDING_PROVIDER_UNAVAILABLE", "unavailable"));
    vi.spyOn(memoryRetrievalRepository, "searchWithConflictClosure").mockResolvedValue(empty);
    const activate = vi.spyOn(memoryThreadBriefRepository, "activate").mockResolvedValue({ threads: [], totalCharacters: 0 });
    await retrieveMemoryTurnContext(auth, "термометр", []);
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ auth, queryEmbedding: null }));
  });

  it("does not disguise configuration or authorization failures as degradation", async () => {
    vi.spyOn(embeddings, "embedMemoryQuery").mockRejectedValue(new AppError("AGENT_MEMORY_EMBEDDING_CONFIG_MISSING", "missing"));
    const search = vi.spyOn(memoryRetrievalRepository, "searchWithConflictClosure");
    await expect(retrieveRelevantMemories(auth, "термометр")).rejects.toThrow("CONFIG_MISSING");
    expect(search).not.toHaveBeenCalled();
  });
});
