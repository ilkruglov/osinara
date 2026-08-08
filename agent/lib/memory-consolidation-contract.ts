/**
 * Shared application-owned semantic consolidation contracts.
 *
 * Export:
 * - `MemoryConsolidationResolution`: guarded relation and internal target used only by persistence.
 */
export interface MemoryConsolidationResolution {
  relation: "conflict" | "correction" | "duplicate" | "new" | "refinement" | "temporal_update";
  targetClaimId: string | null;
}
