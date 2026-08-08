/**
 * Contiguous extraction progress, retention holds, and durable lost-range diagnostics.
 *
 * Exports:
 * - `releaseExtractionHoldsAndAdvance`: releases snapshotted rows and advances contiguous coverage.
 * - `rejectExtractionEntriesAndAdvance`: records terminal source exclusions without retaining text.
 * - `recordTerminalExtractionEntries`: locked standalone terminal-exclusion boundary.
 * - `recordNextExtractionGap`: records one historical range whose timeline plaintext is unavailable.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import { database } from "./database.js";
import {
  MEMORY_EXTRACTION_EXTRACTOR_VERSION,
  MEMORY_EXTRACTION_SCHEMA_VERSION,
} from "./memory-config.js";

async function advanceContiguousProgress(
  client: Pick<PoolClient, "query">,
  conversationId: string,
): Promise<void> {
  // Coverage points and diagnosed gap ranges are the only states allowed to advance this cursor.
  await client.query(
    `WITH RECURSIVE progress(sequence_id) AS (
       SELECT last_contiguous_sequence
       FROM conversation_extraction_cursors WHERE conversation_id = $1
       UNION ALL
       SELECT next_position.sequence_id
       FROM progress
       CROSS JOIN LATERAL (
         SELECT max(candidate.sequence_id) AS sequence_id
         FROM (
           SELECT gap.last_sequence AS sequence_id
           FROM memory_extraction_gaps AS gap
           WHERE gap.conversation_id = $1
             AND gap.first_sequence <= progress.sequence_id + 1
             AND gap.last_sequence >= progress.sequence_id + 1
           UNION ALL
           SELECT coverage.timeline_sequence AS sequence_id
           FROM memory_extraction_entry_coverage AS coverage
           WHERE coverage.conversation_id = $1
             AND coverage.extractor_version = $2 AND coverage.schema_version = $3
             AND coverage.timeline_sequence = progress.sequence_id + 1
         ) AS candidate
       ) AS next_position
       WHERE next_position.sequence_id IS NOT NULL
         AND next_position.sequence_id > progress.sequence_id
     ), boundary AS (
       SELECT max(sequence_id) AS sequence_id FROM progress
     )
     UPDATE conversation_extraction_cursors AS cursor
     SET last_contiguous_sequence = boundary.sequence_id, updated_at = now()
     FROM boundary WHERE cursor.conversation_id = $1`,
    [conversationId, MEMORY_EXTRACTION_EXTRACTOR_VERSION, MEMORY_EXTRACTION_SCHEMA_VERSION],
  );
}

export async function releaseExtractionHoldsAndAdvance(
  client: PoolClient,
  conversationId: string,
  timelineEntryIds: readonly string[],
): Promise<void> {
  await client.query(
    `DELETE FROM memory_extraction_retention_holds
     WHERE conversation_id = $1 AND timeline_entry_id = ANY($2::uuid[])`,
    [conversationId, timelineEntryIds],
  );
  await advanceContiguousProgress(client, conversationId);
}

export async function rejectExtractionEntriesAndAdvance(
  client: Pick<PoolClient, "query">,
  conversationId: string,
  entries: readonly { id: string; sequenceId: string }[],
  diagnosticCode: string,
): Promise<void> {
  if (entries.length === 0) return;
  if (!/^AGENT_[A-Z0-9_]+$/u.test(diagnosticCode)) {
    throw new AppError(
      "AGENT_MEMORY_EXTRACTION_DIAGNOSTIC_INVALID",
      "Для необрабатываемой записи памяти требуется стабильный диагностический код",
    );
  }
  const eligible = await client.query<{ id: string; sequence_id: string }>(
    `SELECT candidate.id::text, candidate.sequence_id::text
     FROM unnest($2::uuid[], $3::bigint[]) AS candidate(id, sequence_id)
     JOIN telegram_group_messages AS entry
       ON entry.id = candidate.id AND entry.conversation_id = $1
     WHERE NOT EXISTS (
       SELECT 1 FROM memory_extraction_entry_coverage AS coverage
       WHERE coverage.conversation_id = $1 AND coverage.timeline_entry_id_snapshot = candidate.id
     )
       AND NOT EXISTS (
         SELECT 1 FROM memory_extraction_gaps AS gap
         WHERE gap.conversation_id = $1
           AND candidate.sequence_id BETWEEN gap.first_sequence AND gap.last_sequence
       )`,
    [conversationId, entries.map((entry) => entry.id), entries.map((entry) => entry.sequenceId)],
  );
  if (eligible.rows.length === 0) return;
  // Each rejected coordinate remains explicit; no source plaintext is copied into diagnostics.
  await client.query(
    `INSERT INTO memory_extraction_gaps
       (conversation_id, first_sequence, last_sequence, diagnostic_code)
     SELECT $1, rejected.sequence_id, rejected.sequence_id, $3
     FROM unnest($2::bigint[]) AS rejected(sequence_id)
     ON CONFLICT (conversation_id, first_sequence, last_sequence) DO NOTHING`,
    [conversationId, eligible.rows.map((entry) => entry.sequence_id), diagnosticCode],
  );
  await client.query(
    `DELETE FROM memory_extraction_retention_holds
     WHERE conversation_id = $1 AND timeline_entry_id = ANY($2::uuid[])`,
    [conversationId, eligible.rows.map((entry) => entry.id)],
  );
  await advanceContiguousProgress(client, conversationId);
}

export async function recordTerminalExtractionEntries(
  conversationId: string,
  entries: readonly { id: string; sequenceId: string }[],
  diagnosticCode: string,
): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    // Timeline writers, snapshots, and terminal exclusions serialize on one conversation key.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [conversationId]);
    await rejectExtractionEntriesAndAdvance(client, conversationId, entries, diagnosticCode);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recordNextExtractionGap(): Promise<boolean> {
  const selected = await database().query<{ id: string }>(
    `SELECT conversation.id
     FROM application_conversations AS conversation
     JOIN conversation_extraction_cursors AS cursor ON cursor.conversation_id = conversation.id
     WHERE conversation.next_timeline_sequence > cursor.last_contiguous_sequence
       AND NOT EXISTS (
         SELECT 1 FROM memory_extraction_entry_coverage AS coverage
         WHERE coverage.conversation_id = conversation.id
           AND coverage.extractor_version = $1 AND coverage.schema_version = $2
           AND coverage.timeline_sequence = cursor.last_contiguous_sequence + 1
       )
       AND NOT EXISTS (
         SELECT 1 FROM telegram_group_messages AS entry
         WHERE entry.conversation_id = conversation.id
           AND entry.sequence_id = cursor.last_contiguous_sequence + 1
       )
       AND NOT EXISTS (
         SELECT 1 FROM memory_extraction_gaps AS gap
         WHERE gap.conversation_id = conversation.id
           AND gap.first_sequence <= cursor.last_contiguous_sequence + 1
           AND gap.last_sequence >= cursor.last_contiguous_sequence + 1
       )
     ORDER BY conversation.updated_at, conversation.id LIMIT 1`,
    [MEMORY_EXTRACTION_EXTRACTOR_VERSION, MEMORY_EXTRACTION_SCHEMA_VERSION],
  );
  const conversationId = selected.rows[0]?.id;
  if (!conversationId) return false;

  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [conversationId]);
    const state = await client.query<{
      last_contiguous_sequence: string;
      next_timeline_sequence: string;
    }>(
      `SELECT cursor.last_contiguous_sequence::text, conversation.next_timeline_sequence::text
       FROM conversation_extraction_cursors AS cursor
       JOIN application_conversations AS conversation ON conversation.id = cursor.conversation_id
       WHERE cursor.conversation_id = $1 FOR UPDATE OF cursor`,
      [conversationId],
    );
    const row = state.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return false;
    }
    const current = BigInt(row.last_contiguous_sequence);
    const highWatermark = BigInt(row.next_timeline_sequence);
    const available = await client.query<{ sequence_id: string }>(
      `SELECT min(position.sequence_id)::text AS sequence_id
       FROM (
         SELECT entry.sequence_id
         FROM telegram_group_messages AS entry
         WHERE entry.conversation_id = $1 AND entry.sequence_id > $2::bigint
         UNION ALL
         SELECT coverage.timeline_sequence AS sequence_id
         FROM memory_extraction_entry_coverage AS coverage
         WHERE coverage.conversation_id = $1 AND coverage.timeline_sequence > $2::bigint
           AND coverage.extractor_version = $3 AND coverage.schema_version = $4
       ) AS position`,
      [conversationId, current.toString(), MEMORY_EXTRACTION_EXTRACTOR_VERSION,
        MEMORY_EXTRACTION_SCHEMA_VERSION],
    );
    const nextAvailable = available.rows[0]?.sequence_id;
    const firstMissing = current + 1n;
    const lastMissing = nextAvailable === null || nextAvailable === undefined
      ? highWatermark
      : BigInt(nextAvailable) - 1n;
    if (lastMissing >= firstMissing) {
      await client.query(
        `INSERT INTO memory_extraction_gaps
           (conversation_id, first_sequence, last_sequence, diagnostic_code)
         VALUES ($1, $2, $3, 'AGENT_MEMORY_EXTRACTION_TIMELINE_GAP')
         ON CONFLICT (conversation_id, first_sequence, last_sequence) DO NOTHING`,
        [conversationId, firstMissing.toString(), lastMissing.toString()],
      );
    }
    await advanceContiguousProgress(client, conversationId);
    await client.query("COMMIT");
    return lastMissing >= firstMissing;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
