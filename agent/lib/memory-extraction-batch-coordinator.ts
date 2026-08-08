/**
 * Turn-boundary and background catch-up extraction batch coordinator.
 *
 * Exports:
 * - `createTurnExtractionBatch`: snapshots exactly the entries passed to one completed model turn.
 * - `createCatchUpExtractionBatches`: bounded recovery for uncovered conversation timeline entries.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import type { MemoryExtractionBatch } from "./memory-extraction-contract.js";
import { memoryExtractionRepository } from "./memory-extraction-repository.js";
import {
  recordNextExtractionGap,
  recordTerminalExtractionEntries,
} from "./memory-extraction-progress-repository.js";
import {
  MEMORY_EXTRACTION_CATCH_UP_CONVERSATIONS_PER_PASS,
  MEMORY_EXTRACTION_EXTRACTOR_VERSION,
  MEMORY_EXTRACTION_INPUT_MAX_CHARACTERS,
  MEMORY_EXTRACTION_SCHEMA_VERSION,
  MEMORY_EXTRACTION_SNAPSHOT_MAX_ENTRIES,
} from "./memory-config.js";

interface TimelineCoordinate {
  content_text: string | null;
  id: string;
  message_thread_id: string | null;
  sequence_id: string;
}

async function coordinates(
  conversationId: string,
  entryIds: readonly string[],
): Promise<TimelineCoordinate[]> {
  const result = await database().query<TimelineCoordinate>(
    `SELECT id, sequence_id::text, message_thread_id::text, content_text
     FROM telegram_group_messages
     WHERE conversation_id = $1 AND id = ANY($2::uuid[])
     ORDER BY telegram_group_messages.sequence_id`,
    [conversationId, entryIds],
  );
  if (result.rows.length !== entryIds.length) {
    throw new AppError(
      "AGENT_MEMORY_EXTRACTION_TIMELINE_BOUNDARY_INVALID",
      "Одна или несколько видимых записей разговора больше недоступны",
    );
  }
  return result.rows;
}

async function createExactBatch(input: {
  applicationSessionId: string | null;
  callerTelegramUserId: string | null;
  conversationId: string;
  entryIds: readonly string[];
  eveSessionId: string | null;
  omittedBeforeSequence: string | null;
  skipCoveredEntries: boolean;
  turnId: string;
}): Promise<MemoryExtractionBatch | null> {
  if (input.entryIds.length === 0 || input.entryIds.length > MEMORY_EXTRACTION_SNAPSHOT_MAX_ENTRIES) {
    throw new AppError(
      "AGENT_MEMORY_EXTRACTION_BATCH_INVALID",
      "Видимый диапазон turn пуст или превышает extraction bound",
    );
  }
  const rows = await coordinates(input.conversationId, input.entryIds);
  const characters = rows.reduce((total, row) => total + (row.content_text?.length ?? 0), 0);
  if (characters > MEMORY_EXTRACTION_INPUT_MAX_CHARACTERS) {
    throw new AppError(
      "AGENT_MEMORY_EXTRACTION_INPUT_TOO_LARGE",
      "Видимый turn превышает extraction character bound",
    );
  }
  const threads = new Set(rows.map((row) => row.message_thread_id));
  const messageThreadId = threads.size === 1 ? rows[0]!.message_thread_id : null;
  const batchInput = {
    applicationSessionId: input.applicationSessionId,
    callerTelegramUserId: input.callerTelegramUserId,
    conversationId: input.conversationId,
    extractorVersion: MEMORY_EXTRACTION_EXTRACTOR_VERSION,
    firstSequence: rows[0]!.sequence_id,
    lastSequence: rows.at(-1)!.sequence_id,
    messageThreadId,
    omittedBeforeSequence: input.omittedBeforeSequence,
    schemaVersion: MEMORY_EXTRACTION_SCHEMA_VERSION,
    timelineEntryIds: rows.map((row) => row.id),
    turnId: input.turnId,
  };
  if (!input.skipCoveredEntries) {
    return await memoryExtractionRepository.createRecoveryBatch(batchInput);
  }
  if (input.applicationSessionId === null || input.eveSessionId === null) {
    throw new AppError(
      "AGENT_MEMORY_EXTRACTION_SESSION_BOUNDARY_INVALID",
      "Turn-пакет извлечения не связан с текущей сессией Eve",
    );
  }
  return await memoryExtractionRepository.createTurnBatch({
    ...batchInput,
    applicationSessionId: input.applicationSessionId,
    eveSessionId: input.eveSessionId,
  });
}

export async function createTurnExtractionBatch(input: {
  applicationSessionId: string;
  callerTelegramUserId: string;
  conversationId: string;
  entryIds: readonly string[];
  eveSessionId: string;
  omittedBeforeSequence: string | null;
  turnId: string;
}): Promise<MemoryExtractionBatch | null> {
  // Turn coverage converges under the repository lock if catch-up already owns all or part of it.
  return await createExactBatch({ ...input, skipCoveredEntries: true });
}

function boundedByCharacters(rows: readonly TimelineCoordinate[]): TimelineCoordinate[] {
  const selected: TimelineCoordinate[] = [];
  let characters = 0;
  for (const row of rows) {
    const next = characters + (row.content_text?.length ?? 0);
    if (next > MEMORY_EXTRACTION_INPUT_MAX_CHARACTERS) break;
    selected.push(row);
    characters = next;
  }
  return selected;
}

export async function createCatchUpExtractionBatches(): Promise<number> {
  // Record one already-lost historical range before selecting retained plaintext for new snapshots.
  await recordNextExtractionGap();
  const conversations = await database().query<{ id: string }>(
    `SELECT conversation.id
     FROM application_conversations AS conversation
     WHERE EXISTS (
       SELECT 1 FROM telegram_group_messages AS entry
       WHERE entry.conversation_id = conversation.id
          AND NOT EXISTS (
            SELECT 1 FROM memory_extraction_entry_coverage AS coverage
           WHERE coverage.conversation_id = conversation.id
             AND coverage.timeline_entry_id_snapshot = entry.id
              AND coverage.extractor_version = $1 AND coverage.schema_version = $2
          )
          AND NOT EXISTS (
            SELECT 1 FROM memory_extraction_gaps AS gap
            WHERE gap.conversation_id = conversation.id
              AND entry.sequence_id BETWEEN gap.first_sequence AND gap.last_sequence
          )
     )
     ORDER BY conversation.updated_at, conversation.id
     LIMIT $3`,
    [MEMORY_EXTRACTION_EXTRACTOR_VERSION, MEMORY_EXTRACTION_SCHEMA_VERSION,
      MEMORY_EXTRACTION_CATCH_UP_CONVERSATIONS_PER_PASS],
  );
  let created = 0;
  for (const conversation of conversations.rows) {
    const uncovered = await database().query<TimelineCoordinate>(
      `SELECT entry.id, entry.sequence_id::text, entry.message_thread_id::text, entry.content_text
       FROM telegram_group_messages AS entry
       WHERE entry.conversation_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM memory_extraction_entry_coverage AS coverage
           WHERE coverage.conversation_id = $1
             AND coverage.timeline_entry_id_snapshot = entry.id
              AND coverage.extractor_version = $2 AND coverage.schema_version = $3
          )
          AND NOT EXISTS (
            SELECT 1 FROM memory_extraction_gaps AS gap
            WHERE gap.conversation_id = $1
              AND entry.sequence_id BETWEEN gap.first_sequence AND gap.last_sequence
          )
       ORDER BY entry.sequence_id
       LIMIT $4`,
      [conversation.id, MEMORY_EXTRACTION_EXTRACTOR_VERSION,
        MEMORY_EXTRACTION_SCHEMA_VERSION, MEMORY_EXTRACTION_SNAPSHOT_MAX_ENTRIES],
    );
    const rows = boundedByCharacters(uncovered.rows);
    if (rows.length === 0) {
      const first = uncovered.rows[0];
      if (first && (first.content_text?.length ?? 0) > MEMORY_EXTRACTION_INPUT_MAX_CHARACTERS) {
        await recordTerminalExtractionEntries(
          conversation.id,
          [{ id: first.id, sequenceId: first.sequence_id }],
          "AGENT_MEMORY_EXTRACTION_ENTRY_TOO_LARGE",
        );
      }
      continue;
    }
    try {
      const batch = await createExactBatch({
        applicationSessionId: null,
        callerTelegramUserId: null,
        conversationId: conversation.id,
        entryIds: rows.map((row) => row.id),
        eveSessionId: null,
        omittedBeforeSequence: null,
        skipCoveredEntries: false,
        turnId: `catchup:${rows[0]!.sequence_id}:${rows.at(-1)!.sequence_id}`,
      });
      if (batch) created += 1;
    } catch (error) {
      // A concurrent turn may have covered the exact entries after selection; no other failure hides.
      if (!(error instanceof AppError) || error.code !== "AGENT_MEMORY_EXTRACTION_RANGE_OVERLAP") {
        throw error;
      }
    }
  }
  return created;
}
