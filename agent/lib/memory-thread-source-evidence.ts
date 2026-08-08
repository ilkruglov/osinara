/**
 * Model-safe provenance projection for memory-thread entries.
 *
 * Exports:
 * - `MemoryThreadSourceEvidence`: primary claim provenance keyed by opaque entry ref.
 * - `loadMemoryThreadSourceEvidence`: loads attribution without exposing database identities.
 */
import type { PoolClient } from "pg";

import { memoryEvidenceNotice, type ModelMemoryEvidence } from "./model-memory.js";

export interface MemoryThreadSourceEvidence extends ModelMemoryEvidence {
  sourceEntryRef: string;
}

export async function loadMemoryThreadSourceEvidence(
  client: Pick<PoolClient, "query">,
  threadId: string,
): Promise<MemoryThreadSourceEvidence[]> {
  const result = await client.query<{
    author_label: string;
    entry_ref: string;
    evidence_kind: ModelMemoryEvidence["kind"];
    observed_at: Date;
  }>(
    `SELECT entry.entry_ref,
            COALESCE(evidence.evidence_kind, 'unresolved') AS evidence_kind,
            COALESCE(evidence.author_label_snapshot, 'Источник не установлен') AS author_label,
            COALESCE(evidence.observed_at, entry.occurred_at) AS observed_at
     FROM memory_thread_entries AS entry
     LEFT JOIN LATERAL (
       SELECT evidence_kind, author_label_snapshot, observed_at
       FROM claim_evidence
       WHERE claim_id = entry.source_claim_id AND evidence_role = 'primary'
       ORDER BY observed_at, id LIMIT 1
     ) AS evidence ON true
     WHERE entry.thread_id = $1
     ORDER BY entry.entry_ref`,
    [threadId],
  );
  return result.rows.map((row) => ({
    authorLabel: row.author_label,
    kind: row.evidence_kind,
    notice: memoryEvidenceNotice(row.evidence_kind),
    observedAt: row.observed_at.toISOString(),
    sourceEntryRef: row.entry_ref,
  }));
}
