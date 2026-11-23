/**
 * Shared PostgreSQL fixtures for memory-review dispatch tests.
 *
 * Exports:
 * - `observe`: journals a run of messages and lets review observe each, as live ingress does.
 * - `setReview`: flips a group's review switch directly, bypassing the owner's policy path.
 * - `ownedExternalGroup`: an external group, review off, with its owner family, as the owner's
 *   policy path expects it.
 * - `insertJournalRun`: plain journal messages with the given sequence numbers, in one topic.
 * - `groupWithFailingReview`: such a group whose review turn runs (`FAILING_REVIEW_TURN`), with a
 *   successor batch, so that its failure skips it and alerts the owner.
 * - `outcome`: "ok", or the error message, of a call raced against another connection.
 */
import { database } from "../database.js";
import { insertReviewUserMessage } from "./memory-review.integration-fixtures.js";
import { memoryReviewRepository } from "./memory-review-repository.js";

export async function observe(
  fixture: { conversationId: string; groupId: string },
  from: number,
  to: number,
  thread?: number,
) {
  for (let sequence = from; sequence <= to; sequence += 1) {
    const source = await insertReviewUserMessage({
      conversationId: fixture.conversationId,
      groupId: fixture.groupId,
      ...(thread === undefined ? {} : { messageThreadId: thread }),
      sequence,
    });
    await memoryReviewRepository.observePassiveMessage({
      groupId: fixture.groupId,
      timelineEntryId: source.id,
    });
  }
}

export const setReview = (groupId: string, enabled: boolean) =>
  database().query("UPDATE telegram_groups SET memory_review_enabled = $2 WHERE id = $1", [
    groupId,
    enabled,
  ]);

/** An external group whose family has one owner; review is off, the journal still empty. */
export async function ownedExternalGroup(chatId: string, nextSequence: number) {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Review') RETURNING id",
  );
  const owner = await database().query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, display_name) VALUES ($1, 'Владелец') RETURNING id`,
    [`owner${chatId}`],
  );
  const familyId = family.rows[0]!.id;
  const ownerId = owner.rows[0]!.id;
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [familyId, ownerId],
  );
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist,
        memory_review_enabled, next_timeline_sequence)
     VALUES ($1, $2, 'Группа', 'external', 'all', '{}', false, $3) RETURNING id`,
    [familyId, chatId, nextSequence],
  );
  const groupId = group.rows[0]!.id;
  const conversation = await database().query<{ id: string }>(
    "SELECT id FROM application_conversations WHERE telegram_group_id = $1",
    [groupId],
  );
  return { conversationId: conversation.rows[0]!.id, familyId, groupId, ownerId };
}

export async function insertJournalRun(
  groupId: string,
  from: number,
  to: number,
  thread: number | null = null,
): Promise<void> {
  await database().query(
    `INSERT INTO telegram_group_messages
       (group_id, sequence_id, actor_kind, actor_id, telegram_message_id, telegram_user_id,
        sender_display_name, sender_is_bot, message_kind, content_text, sent_at, message_thread_id)
     SELECT $1, value, 'user', 'telegram:u', 700 + value, 'u', 'У', false, 'text', 'm' || value,
            now(), $4
       FROM generate_series($2::int, $3::int) AS value`,
    [groupId, from, to, thread],
  );
}

export const FAILING_REVIEW_TURN = { eveSessionId: "eve-race", eveTurnId: "turn-race" } as const;

/**
 * Twenty messages; a review turn holds the first ten, started `startedHoursAgo` (an hour or more is
 * abandoned for the claim pass), and a pending successor waits for the next ten. Its failure skips
 * it and alerts the owner, which inserts a row referencing the group.
 */
export async function groupWithFailingReview(chatId: string, startedHoursAgo = 0) {
  const { conversationId, familyId, groupId, ownerId } = await ownedExternalGroup(chatId, 20);
  await insertJournalRun(groupId, 1, 20);
  const lane = await database().query<{ id: string }>(
    `INSERT INTO memory_review_lanes (conversation_id, message_thread_id, processed_through_sequence)
     VALUES ($1, NULL, 0) RETURNING id`,
    [conversationId],
  );
  const laneId = lane.rows[0]!.id;
  const running = await database().query<{ id: string }>(
    `INSERT INTO memory_review_batches
       (lane_id, conversation_id, batch_kind, status, predecessor_sequence, from_sequence,
        through_sequence, source_count, eve_session_id, eve_turn_id, started_at)
     VALUES ($1, $2, 'background', 'running', 0, 1, 10, 10, $3, $4,
             now() - $5 * interval '1 hour')
     RETURNING id`,
    [
      laneId,
      conversationId,
      FAILING_REVIEW_TURN.eveSessionId,
      FAILING_REVIEW_TURN.eveTurnId,
      startedHoursAgo,
    ],
  );
  const batchId = running.rows[0]!.id;
  await database().query(
    `INSERT INTO memory_review_batch_sources
       (batch_id, conversation_id, timeline_entry_id, timeline_sequence)
     SELECT $1, $2, id, sequence_id FROM telegram_group_messages
      WHERE conversation_id = $2 AND sequence_id BETWEEN 1 AND 10`,
    [batchId, conversationId],
  );
  await database().query(
    `INSERT INTO memory_review_batches
       (lane_id, conversation_id, batch_kind, status, predecessor_sequence, from_sequence,
        through_sequence, source_count)
     VALUES ($1, $2, 'background', 'pending', 10, 11, 20, 10)`,
    [laneId, conversationId],
  );
  return { batchId, familyId, ownerId };
}

export const outcome = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
