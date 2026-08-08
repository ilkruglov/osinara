/**
 * Memory-thread brief source selection and transactional cache persistence.
 *
 * Exports:
 * - `THREAD_BRIEF_MODEL_VERSION`: provider model identity included in every cache key.
 * - `SourceRow`: shared durable source projection used by briefs and episode loading.
 * - `loadCachedBrief`: restores a cache entry only while every source remains authorized.
 * - `loadBriefSources`: selects bounded, evidence-bearing model input for one thread.
 * - `persistBrief`: validates generation and writes blocks plus source links atomically.
 * - `memoryThreadBriefPayloadHash`: hashes generated blocks for durable job completion.
 */
import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import {
  THREAD_BRIEF_INPUT_MAX_CHARACTERS,
  THREAD_BRIEF_MAX_ITEMS,
  THREAD_BRIEF_SCHEMA_VERSION,
} from "./memory-config.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { liveMemoryReadPredicate } from "./memory-live-read-authorization.js";
import type {
  MemoryThreadBriefBlock,
  MemoryThreadBriefSource,
} from "./memory-thread-brief-generator.js";
import { loadMemoryThreadSourceEvidence } from "./memory-thread-source-evidence.js";
import { modelProviderConfig } from "./model-provider-config.js";

export interface SourceRow {
  content: string;
  conflicting_entry_refs?: string[];
  entry_ref: string;
  occurred_at: Date;
  role: MemoryThreadBriefSource["role"];
  source_ref: string;
  unresolved_conflict_refs?: string[];
}

export const THREAD_BRIEF_MODEL_VERSION = modelProviderConfig.agent.models.primary.id;

export function memoryThreadBriefPayloadHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function loadCachedBrief(
  client: PoolClient,
  threadId: string,
  generation: number,
  auth: MemoryAuthorization,
): Promise<MemoryThreadBriefBlock[] | null> {
  const result = await client.query<{
    content: string;
    kind: MemoryThreadBriefBlock["kind"];
    ordinal: number;
    source_record_refs: string[];
    source_refs: string[];
  }>(
    `SELECT block.ordinal, block.kind, block.content,
             array_agg(entry.entry_ref ORDER BY entry.entry_ref) AS source_refs,
             array_agg(COALESCE(memory_ref.memory_ref, outcome.outcome_ref)
               ORDER BY entry.entry_ref) AS source_record_refs
     FROM memory_thread_briefs AS brief
     JOIN memory_threads AS thread ON thread.id = brief.thread_id
     JOIN memory_thread_brief_blocks AS block ON block.brief_id = brief.id
     JOIN memory_thread_brief_block_sources AS source
       ON source.brief_id = block.brief_id AND source.block_ordinal = block.ordinal
     JOIN memory_thread_entries AS entry ON entry.id = source.thread_entry_id
     LEFT JOIN memory_items AS claim ON claim.id = entry.source_claim_id
     LEFT JOIN memory_item_refs AS memory_ref ON memory_ref.memory_item_id = claim.id
      LEFT JOIN confirmed_outcomes AS outcome ON outcome.id = entry.source_outcome_id
      WHERE thread.family_id = $1
        AND ${liveMemoryReadPredicate({
          alias: "thread",
          personalIdentityColumn: "scope_partition_key",
        })}
        AND brief.thread_id = $5 AND brief.generation = $6
        AND brief.model_version = $7 AND brief.schema_version = $8
        AND (
          (claim.claim_status = 'active' AND claim.provenance_state = 'evidenced'
            AND EXISTS (SELECT 1 FROM claim_evidence WHERE claim_id = claim.id)) OR
          outcome.status = 'confirmed'
        )
     GROUP BY block.ordinal, block.kind, block.content ORDER BY block.ordinal`,
    [auth.familyId, auth.scopes, auth.userId, auth.groupId, threadId, generation,
      THREAD_BRIEF_MODEL_VERSION, THREAD_BRIEF_SCHEMA_VERSION],
  );
  if (result.rows.length === 0) return null;
  return result.rows.map((row) => ({
    content: row.content,
    kind: row.kind,
    sourceEntryRefs: row.source_refs,
    sourceRecordRefs: row.source_record_refs,
  }));
}

export async function loadBriefSources(
  client: Pick<PoolClient, "query">,
  threadId: string,
  auth: MemoryAuthorization,
): Promise<MemoryThreadBriefSource[]> {
  const result = await client.query<SourceRow>(
    `SELECT entry.entry_ref, entry.role::text, entry.occurred_at,
             COALESCE(claim.content, outcome.summary) AS content,
             COALESCE(memory_ref.memory_ref, outcome.outcome_ref) AS source_ref,
             COALESCE(conflict.conflict_refs, '{}'::text[]) AS unresolved_conflict_refs,
             COALESCE(conflict.other_entry_refs, '{}'::text[]) AS conflicting_entry_refs
      FROM memory_thread_entries AS entry
      JOIN memory_threads AS thread ON thread.id = entry.thread_id
      LEFT JOIN memory_items AS claim ON claim.id = entry.source_claim_id
        AND claim.claim_status = 'active'
        AND claim.provenance_state = 'evidenced'
        AND EXISTS (SELECT 1 FROM claim_evidence WHERE claim_id = claim.id)
      LEFT JOIN memory_item_refs AS memory_ref ON memory_ref.memory_item_id = claim.id
     LEFT JOIN confirmed_outcomes AS outcome ON outcome.id = entry.source_outcome_id
       AND outcome.status = 'confirmed'
     LEFT JOIN LATERAL (
       SELECT array_agg(DISTINCT disputed.conflict_ref) AS conflict_refs,
              array_agg(DISTINCT other_entry.entry_ref) AS other_entry_refs
       FROM claim_conflicts AS disputed
       JOIN memory_thread_entries AS other_entry
         ON other_entry.thread_id = entry.thread_id
        AND other_entry.source_claim_id = CASE
          WHEN disputed.claim_a_id = claim.id THEN disputed.claim_b_id ELSE disputed.claim_a_id END
       WHERE disputed.resolution = 'unresolved'
         AND claim.id IN (disputed.claim_a_id, disputed.claim_b_id)
      ) AS conflict ON claim.id IS NOT NULL
      WHERE thread.family_id = $1
        AND ${liveMemoryReadPredicate({
          alias: "thread",
          personalIdentityColumn: "scope_partition_key",
        })}
        AND entry.thread_id = $5 AND (claim.id IS NOT NULL OR outcome.id IS NOT NULL)
     ORDER BY CASE WHEN conflict.conflict_refs IS NOT NULL THEN 0 ELSE 1 END,
       CASE entry.role
       WHEN 'constraint' THEN 1 WHEN 'goal' THEN 2 WHEN 'open_loop' THEN 2
       WHEN 'method' THEN 3 WHEN 'decision' THEN 4 WHEN 'outcome' THEN 4
       WHEN 'lesson' THEN 5 ELSE 6 END,
       entry.occurred_at DESC, entry.id DESC
      LIMIT $6`,
    [auth.familyId, auth.scopes, auth.userId, auth.groupId, threadId,
      THREAD_BRIEF_MAX_ITEMS],
  );

  // Provider input is bounded in priority order; lower-priority rows are not partially truncated.
  const bounded: SourceRow[] = [];
  let inputCharacters = 0;
  for (const row of result.rows) {
    if (inputCharacters + row.content.length > THREAD_BRIEF_INPUT_MAX_CHARACTERS) break;
    bounded.push(row);
    inputCharacters += row.content.length;
  }

  // Conflict references and evidence are projected only for selected rows from this same thread.
  const selectedRefs = new Set(bounded.map((row) => row.entry_ref));
  const evidence = new Map((await loadMemoryThreadSourceEvidence(client, threadId, auth))
    .map((item) => [item.sourceEntryRef, item]));
  return bounded.map((row) => {
    const conflictingRefs = (row.conflicting_entry_refs ?? [])
      .filter((entryRef) => selectedRefs.has(entryRef));
    const sourceEvidence = evidence.get(row.entry_ref);
    if (!sourceEvidence) {
      throw new AppError("AGENT_MEMORY_THREAD_NOT_FOUND", "Нить памяти больше недоступна");
    }
    const { sourceEntryRef: _sourceEntryRef, ...modelEvidence } = sourceEvidence;
    return {
      ...(conflictingRefs.length === 0
        ? {}
        : { conflictingEntryRefs: conflictingRefs }),
      content: row.content,
      evidence: modelEvidence,
      occurredAt: row.occurred_at.toISOString(),
      ref: row.entry_ref,
      role: row.role,
      sourceRef: row.source_ref,
      ...((row.unresolved_conflict_refs?.length ?? 0) === 0 || conflictingRefs.length === 0
        ? {}
        : { unresolvedConflictRefs: row.unresolved_conflict_refs }),
    };
  });
}

export async function persistBrief(
  client: PoolClient,
  thread: { generation: number; id: string },
  blocks: readonly MemoryThreadBriefBlock[],
  auth: MemoryAuthorization,
): Promise<void> {
  // Revalidate inside the write transaction before accepting provider output or source refs.
  const current = await client.query<{ generation: number }>(
    `SELECT thread.generation FROM memory_threads AS thread
     WHERE thread.family_id = $1
       AND ${liveMemoryReadPredicate({
         alias: "thread",
         personalIdentityColumn: "scope_partition_key",
       })}
       AND thread.id = $5 FOR UPDATE`,
    [auth.familyId, auth.scopes, auth.userId, auth.groupId, thread.id],
  );
  if (!current.rows[0]) {
    throw new AppError("AGENT_MEMORY_THREAD_NOT_FOUND", "Нить памяти больше недоступна");
  }
  if (current.rows[0].generation !== thread.generation) {
    throw new AppError(
      "AGENT_MEMORY_THREAD_BRIEF_GENERATION_STALE",
      "Нить памяти изменилась во время построения брифа",
    );
  }

  const entryRefs = [...new Set(blocks.flatMap((block) => block.sourceEntryRefs))];
  const entries = await client.query<{ entry_ref: string; id: string }>(
    `SELECT entry.id, entry.entry_ref
     FROM memory_thread_entries AS entry
     JOIN memory_threads AS thread ON thread.id = entry.thread_id
     WHERE thread.family_id = $1
       AND ${liveMemoryReadPredicate({
         alias: "thread",
         personalIdentityColumn: "scope_partition_key",
       })}
       AND entry.thread_id = $5 AND entry.entry_ref = ANY($6::text[])`,
    [auth.familyId, auth.scopes, auth.userId, auth.groupId, thread.id, entryRefs],
  );
  const entryIds = new Map(entries.rows.map((entry) => [entry.entry_ref, entry.id]));
  if (entryIds.size !== entryRefs.length) {
    throw new AppError(
      "AGENT_MEMORY_THREAD_BRIEF_SOURCE_STALE",
      "Источник брифа изменился до сохранения проекции",
    );
  }
  // Blocks and source links share the caller's transaction and immutable generation key.
  const brief = await client.query<{ id: string }>(
    `INSERT INTO memory_thread_briefs
       (thread_id, generation, model_version, schema_version, total_characters, item_count)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [thread.id, thread.generation, THREAD_BRIEF_MODEL_VERSION, THREAD_BRIEF_SCHEMA_VERSION,
      blocks.reduce((sum, block) => sum + block.content.length, 0), blocks.length],
  );
  for (const [ordinal, block] of blocks.entries()) {
    await client.query(
      `INSERT INTO memory_thread_brief_blocks (brief_id, thread_id, ordinal, kind, content)
       VALUES ($1, $2, $3, $4, $5)`,
      [brief.rows[0]!.id, thread.id, ordinal, block.kind, block.content],
    );
    for (const entryRef of block.sourceEntryRefs) {
      await client.query(
        `INSERT INTO memory_thread_brief_block_sources
           (brief_id, block_ordinal, thread_id, thread_entry_id)
         VALUES ($1, $2, $3, $4)`,
        [brief.rows[0]!.id, ordinal, thread.id, entryIds.get(entryRef)],
      );
    }
  }
}
