/**
 * Exact bounded memory extraction batch creation.
 *
 * Exports:
 * - `memoryExtractionBatchRepository`: exact and overlap-safe turn snapshot creation.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import {
  extractionPayloadHash,
  loadExtractionBatch,
  requireExtractionBigint,
  type CreateMemoryExtractionBatchInput,
  type CreateTurnMemoryExtractionBatchInput,
  type MemoryExtractionBatch,
} from "./memory-extraction-contract.js";
import {
  MEMORY_EXTRACTION_INPUT_MAX_CHARACTERS,
  MEMORY_EXTRACTION_SNAPSHOT_MAX_ENTRIES,
  MEMORY_EXTRACTION_VERSION_MAX_CHARACTERS,
} from "./memory-config.js";
import {
  rejectExtractionEntriesAndAdvance,
  releaseExtractionHoldsAndAdvance,
} from "./memory-extraction-progress-repository.js";

interface TimelineSnapshotRow {
  actor_kind: "agent_self" | "user";
  content_text: string | null;
  id: string;
  message_thread_id: string | null;
  reply_to_sequence_id: string | null;
  sender_display_name: string | null;
  sent_at: Date;
  sequence_id: string;
  telegram_message_id: string;
  telegram_user_id: string | null;
}

type CoverageMode = "reject" | "skip";
type PersistedMemoryExtractionBatchInput = CreateMemoryExtractionBatchInput & {
  batchKind: "catchup" | "turn";
  eveSessionId: string | null;
};

function validateBatchInput(input: PersistedMemoryExtractionBatchInput): {
  entryIds: string[];
  messageThreadId: string | null;
} {
  const entryIds = [...new Set(input.timelineEntryIds)];
  const first = requireExtractionBigint(input.firstSequence, "firstSequence");
  const last = requireExtractionBigint(input.lastSequence, "lastSequence");
  const omitted = input.omittedBeforeSequence === null
    ? null
    : requireExtractionBigint(input.omittedBeforeSequence, "omittedBeforeSequence", true);
  const messageThreadId = input.messageThreadId ?? null;
  if (
    first > last ||
    (omitted !== null && omitted >= first) ||
    entryIds.length === 0 ||
    entryIds.length !== input.timelineEntryIds.length ||
    entryIds.length > MEMORY_EXTRACTION_SNAPSHOT_MAX_ENTRIES ||
    !input.extractorVersion.trim() ||
    !input.schemaVersion.trim() ||
    input.extractorVersion.length > MEMORY_EXTRACTION_VERSION_MAX_CHARACTERS ||
    input.schemaVersion.length > MEMORY_EXTRACTION_VERSION_MAX_CHARACTERS ||
    !input.turnId.trim() ||
    (input.batchKind === "turn" &&
      (input.applicationSessionId === null || input.eveSessionId === null || !input.eveSessionId.trim())) ||
    (input.batchKind === "catchup" &&
      (input.applicationSessionId !== null || input.eveSessionId !== null))
  ) {
    throw new AppError(
      "AGENT_MEMORY_EXTRACTION_BATCH_INVALID",
      "Параметры пакета извлечения неполны или выходят за допустимые границы",
    );
  }
  if (input.callerTelegramUserId !== null) {
    requireExtractionBigint(input.callerTelegramUserId, "callerTelegramUserId");
  }
  if (messageThreadId !== null) requireExtractionBigint(messageThreadId, "messageThreadId");
  return { entryIds, messageThreadId };
}

function snapshotPayload(entries: readonly TimelineSnapshotRow[]): unknown[] {
  return entries.map((entry) => ({
    actorKind: entry.actor_kind,
    actorLabelSnapshot: entry.sender_display_name,
    contentText: entry.content_text,
    messageThreadId: entry.message_thread_id,
    observedAt: entry.sent_at.toISOString(),
    replyToSequenceId: entry.reply_to_sequence_id,
    sequenceId: entry.sequence_id,
    telegramMessageId: entry.telegram_message_id,
    timelineEntryId: entry.id,
  }));
}

function requestIdentityHash(
  input: PersistedMemoryExtractionBatchInput,
  entryIds: readonly string[],
  messageThreadId: string | null,
): string {
  return extractionPayloadHash({
    applicationSessionId: input.applicationSessionId,
    callerTelegramUserId: input.callerTelegramUserId,
    firstSequence: input.firstSequence,
    lastSequence: input.lastSequence,
    messageThreadId,
    omittedBeforeSequence: input.omittedBeforeSequence,
    timelineEntryIds: entryIds,
  });
}

async function createBatch(
  input: PersistedMemoryExtractionBatchInput,
  coverageMode: CoverageMode,
): Promise<MemoryExtractionBatch | null> {
  const { entryIds, messageThreadId } = validateBatchInput(input);
  if (coverageMode === "skip" && input.callerTelegramUserId === null) {
    throw new AppError(
      "AGENT_MEMORY_EXTRACTION_CALLER_MISSING",
      "Не задан проверенный инициатор turn-пакета извлечения памяти",
    );
  }
  const identityHash = requestIdentityHash(input, entryIds, messageThreadId);
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const replay = await client.query<{
      id: string;
      request_identity_hash: string;
    }>(
      `SELECT id, request_identity_hash FROM memory_extraction_batches
       WHERE conversation_id = $1 AND batch_kind = $2
         AND eve_session_id IS NOT DISTINCT FROM $3 AND turn_id = $4
         AND extractor_version = $5 AND schema_version = $6`,
      [input.conversationId, input.batchKind, input.eveSessionId, input.turnId,
        input.extractorVersion, input.schemaVersion],
    );
    if (replay.rows[0]) {
      const stored = replay.rows[0];
      if (stored.request_identity_hash !== identityHash) {
        throw new AppError(
          "AGENT_MEMORY_EXTRACTION_REPLAY_MISMATCH",
          "Повтор пакета извлечения не совпадает с исходным диапазоном",
        );
      }
      await client.query("COMMIT");
      return await loadExtractionBatch(client, stored.id);
    }

    const conversations = await client.query<{
      family_id: string;
      scope: "family" | "group" | "personal";
      scope_partition_key: string;
      owner_user_id: string | null;
      telegram_group_id: string | null;
    }>(
      `SELECT family_id, owner_user_id, scope, scope_partition_key, telegram_group_id
       FROM application_conversations WHERE id = $1 FOR SHARE`,
      [input.conversationId],
    );
    const conversation = conversations.rows[0];
    if (!conversation) {
      throw new AppError(
        "AGENT_APPLICATION_CONVERSATION_NOT_FOUND",
        "Стабильный разговор больше не существует",
      );
    }
    if (input.applicationSessionId !== null) {
      const session = await client.query(
        `SELECT 1 FROM conversation_sessions
         WHERE id = $1 AND family_id = $2 AND scope = $4
           AND group_id IS NOT DISTINCT FROM $3
           AND owner_user_id IS NOT DISTINCT FROM $5`,
        [input.applicationSessionId, conversation.family_id,
          conversation.telegram_group_id, conversation.scope, conversation.owner_user_id],
      );
      if (!session.rowCount) {
        throw new AppError(
          "AGENT_MEMORY_EXTRACTION_SESSION_BOUNDARY_INVALID",
          "Сессия не принадлежит исходному разговору",
        );
      }
    }

    // The verified Telegram caller is linked on the server and remains separate from source authors.
    let callerUserId: string | null = null;
    if (input.callerTelegramUserId !== null) {
      const caller = await client.query<{ id: string }>(
        `SELECT app_user.id FROM users AS app_user
         JOIN family_memberships AS membership ON membership.user_id = app_user.id
         WHERE app_user.telegram_user_id = $1 AND membership.family_id = $2`,
        [input.callerTelegramUserId, conversation.family_id],
      );
      callerUserId = caller.rows[0]?.id ?? null;
      if (conversation.scope === "personal" && callerUserId !== conversation.owner_user_id) {
        throw new AppError(
          "AGENT_MEMORY_EXTRACTION_CALLER_INVALID",
          "Инициатор личного извлечения не является владельцем разговора",
        );
      }
      if (conversation.scope === "family") {
        if (!callerUserId) {
          throw new AppError(
            "AGENT_MEMORY_EXTRACTION_CALLER_INVALID",
            "Инициатор семейного извлечения больше не состоит в семье",
          );
        }
      }
    }

    // Timeline writers and every batch mode share this lock, making overlap filtering atomic.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [input.conversationId],
    );
    const selected = await client.query<TimelineSnapshotRow>(
      `SELECT id, sequence_id::text, actor_kind, telegram_user_id, sender_display_name,
              sent_at, content_text, telegram_message_id::text, message_thread_id::text,
              reply_to_sequence_id::text
       FROM telegram_group_messages
        WHERE conversation_id = $1 AND id = ANY($2::uuid[])
       ORDER BY telegram_group_messages.sequence_id`,
      [input.conversationId, entryIds],
    );
    const requestedEntries = selected.rows;
    if (
      requestedEntries.length !== entryIds.length ||
      requestedEntries.map((entry) => entry.id).join() !== entryIds.join() ||
      requestedEntries[0]?.sequence_id !== input.firstSequence ||
      requestedEntries.at(-1)?.sequence_id !== input.lastSequence ||
      requestedEntries.some((entry) => entry.actor_kind === "user" && entry.telegram_user_id === null) ||
      (messageThreadId !== null && requestedEntries.some((entry) => entry.message_thread_id !== messageThreadId))
    ) {
      throw new AppError(
        "AGENT_MEMORY_EXTRACTION_TIMELINE_BOUNDARY_INVALID",
        "Записи пакета не образуют точный проверенный диапазон выбранного разговора",
      );
    }

    let entries = requestedEntries;
    if (coverageMode === "skip") {
      const covered = await client.query<{ timeline_entry_id_snapshot: string }>(
        `SELECT timeline_entry_id_snapshot FROM memory_extraction_entry_coverage
         WHERE conversation_id = $1 AND timeline_entry_id_snapshot = ANY($2::uuid[])
           AND extractor_version = $3 AND schema_version = $4`,
        [input.conversationId, entryIds, input.extractorVersion, input.schemaVersion],
      );
      const coveredIds = new Set(covered.rows.map((row) => row.timeline_entry_id_snapshot));
      entries = requestedEntries.filter((entry) => !coveredIds.has(entry.id));
      if (entries.length === 0) {
        await client.query("COMMIT");
        return null;
      }
    }

    // A family-private source is authorized per user entry, not only by the turn caller. Rejected
    // coordinates become terminal gaps before any snapshot or external provider boundary exists.
    if (conversation.scope === "family") {
      const activeAuthors = await client.query<{ telegram_user_id: string }>(
        `SELECT app_user.telegram_user_id
         FROM users AS app_user
         JOIN family_memberships AS membership ON membership.user_id = app_user.id
         WHERE membership.family_id = $1
           AND app_user.telegram_user_id = ANY($2::text[])`,
        [conversation.family_id, entries.flatMap((entry) =>
          entry.actor_kind === "user" && entry.telegram_user_id ? [entry.telegram_user_id] : []
        )],
      );
      const allowedTelegramIds = new Set(activeAuthors.rows.map((row) => row.telegram_user_id));
      const rejected = entries.filter((entry) =>
        entry.actor_kind === "user" &&
        (entry.telegram_user_id === null || !allowedTelegramIds.has(entry.telegram_user_id))
      );
      await rejectExtractionEntriesAndAdvance(
        client,
        input.conversationId,
        rejected.map((entry) => ({ id: entry.id, sequenceId: entry.sequence_id })),
        "AGENT_MEMORY_EXTRACTION_FAMILY_SOURCE_DENIED",
      );
      const rejectedIds = new Set(rejected.map((entry) => entry.id));
      entries = entries.filter((entry) => !rejectedIds.has(entry.id));
      if (entries.length === 0) {
        await client.query("COMMIT");
        return null;
      }
    }

    const effectiveEntryIds = entries.map((entry) => entry.id);
    const characters = entries.reduce((sum, entry) => sum + (entry.content_text?.length ?? 0), 0);
    if (characters > MEMORY_EXTRACTION_INPUT_MAX_CHARACTERS) {
      throw new AppError(
        "AGENT_MEMORY_EXTRACTION_INPUT_TOO_LARGE",
        "Текст пакета извлечения превышает допустимый размер",
      );
    }
    const effectiveThreads = new Set(entries.map((entry) => entry.message_thread_id));
    const effectiveMessageThreadId = effectiveThreads.size === 1 ? entries[0]!.message_thread_id : null;

    // Participant identity comes only from verified timeline Telegram IDs.
    for (const entry of entries.filter((candidate) => candidate.actor_kind === "user")) {
      await client.query(
        `INSERT INTO conversation_participants
           (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
            linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
         VALUES ($1, $2, $3, $4, $5,
                 (SELECT id FROM users WHERE telegram_user_id = $5), $6, $7, $7)
         ON CONFLICT (conversation_id, telegram_user_id) DO UPDATE
         SET linked_user_id = (SELECT id FROM users WHERE telegram_user_id = EXCLUDED.telegram_user_id),
             display_name_snapshot = CASE WHEN EXCLUDED.last_observed_at >= conversation_participants.last_observed_at
               THEN EXCLUDED.display_name_snapshot ELSE conversation_participants.display_name_snapshot END,
             first_observed_at = least(conversation_participants.first_observed_at, EXCLUDED.first_observed_at),
             last_observed_at = greatest(conversation_participants.last_observed_at, EXCLUDED.last_observed_at),
             updated_at = now()`,
        [input.conversationId, conversation.family_id, conversation.scope,
          conversation.scope_partition_key, entry.telegram_user_id,
          entry.sender_display_name, entry.sent_at],
      );
    }

    const inputPayloadHash = extractionPayloadHash(snapshotPayload(entries));
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO memory_extraction_batches
         (conversation_id, family_id, scope, scope_partition_key, application_session_id,
          batch_kind, eve_session_id, caller_user_id, caller_telegram_user_id, turn_id,
          extractor_version, schema_version, request_identity_hash, input_payload_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
      [input.conversationId, conversation.family_id, conversation.scope,
        conversation.scope_partition_key, input.applicationSessionId, input.batchKind,
        input.eveSessionId, callerUserId, input.callerTelegramUserId, input.turnId,
        input.extractorVersion, input.schemaVersion, identityHash, inputPayloadHash],
    );
    const batchId = inserted.rows[0]!.id;
    const coverage = await client.query(
      `INSERT INTO memory_extraction_entry_coverage
         (conversation_id, timeline_entry_id_snapshot, timeline_sequence,
          extractor_version, schema_version, batch_id)
       SELECT $1, id, sequence_id, $2, $3, $4
       FROM telegram_group_messages
       WHERE conversation_id = $1 AND id = ANY($5::uuid[])
       ON CONFLICT DO NOTHING`,
      [input.conversationId, input.extractorVersion, input.schemaVersion, batchId, effectiveEntryIds],
    );
    if (coverage.rowCount !== effectiveEntryIds.length) {
      throw new AppError(
        "AGENT_MEMORY_EXTRACTION_RANGE_OVERLAP",
        "Одна или несколько записей уже принадлежат другому extraction batch этой версии",
      );
    }
    await client.query(
      `INSERT INTO memory_extraction_ranges
         (batch_id, conversation_id, first_sequence, last_sequence,
          omitted_before_sequence, message_thread_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [batchId, input.conversationId, entries[0]!.sequence_id, entries.at(-1)!.sequence_id,
        input.omittedBeforeSequence, effectiveMessageThreadId],
    );
    for (const [ordinal, entry] of entries.entries()) {
      const participant = entry.telegram_user_id === null
        ? null
        : (await client.query<{ id: string }>(
            `SELECT id FROM conversation_participants
             WHERE conversation_id = $1 AND telegram_user_id = $2`,
            [input.conversationId, entry.telegram_user_id],
          )).rows[0]?.id ?? null;
      await client.query(
        `INSERT INTO memory_extraction_snapshot_entries
           (batch_id, conversation_id, ordinal, timeline_entry_id, timeline_entry_id_snapshot,
            telegram_group_id, sequence_id, actor_kind, author_participant_id,
            actor_label_snapshot, observed_at, content_text, content_hash,
            telegram_message_id, message_thread_id, reply_to_sequence_id)
         VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [batchId, input.conversationId, ordinal, entry.id, conversation.telegram_group_id,
          entry.sequence_id, entry.actor_kind, participant, entry.sender_display_name,
          entry.sent_at, entry.content_text, extractionPayloadHash(entry.content_text),
          entry.telegram_message_id, entry.message_thread_id, entry.reply_to_sequence_id],
      );
    }
    await releaseExtractionHoldsAndAdvance(client, input.conversationId, effectiveEntryIds);
    await client.query("COMMIT");
    return await loadExtractionBatch(client, batchId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export const memoryExtractionBatchRepository = {
  async getBatch(batchId: string): Promise<MemoryExtractionBatch> {
    const client = await database().connect();
    try {
      return await loadExtractionBatch(client, batchId);
    } finally {
      client.release();
    }
  },

  async createBatch(input: CreateMemoryExtractionBatchInput): Promise<MemoryExtractionBatch> {
    const batch = await createBatch({ ...input, batchKind: "catchup", eveSessionId: null }, "reject");
    if (!batch) {
      throw new AppError(
        "AGENT_MEMORY_EXTRACTION_BATCH_CREATE_FAILED",
        "Не удалось создать обязательный пакет извлечения памяти",
      );
    }
    return batch;
  },

  async createRecoveryBatch(
    input: CreateMemoryExtractionBatchInput,
  ): Promise<MemoryExtractionBatch | null> {
    return await createBatch({ ...input, batchKind: "catchup", eveSessionId: null }, "reject");
  },

  async createTurnBatch(
    input: CreateTurnMemoryExtractionBatchInput,
  ): Promise<MemoryExtractionBatch | null> {
    return await createBatch({ ...input, batchKind: "turn" }, "skip");
  },
};
