/**
 * The owner turns silent review back on while a review turn of the same group fails.
 *
 * Constructs covered:
 * - `updatePolicy` locks the group row so that a concurrent review failure, which holds its lane
 *   and then inserts an owner alert referencing the group (a key-share lock), is not deadlocked
 *   by the restart taking that lane (final review, 22 November 2026: `FOR UPDATE` gave the owner
 *   a raw `40P01`). The interleaving is forced: a third connection holds the failure between its
 *   lane lock and its alert until the policy update waits on the lane.
 * - With two forum topics the restart locks their lanes in one order and the claim pass resolves
 *   abandoned turns in another: the restart takes the claim pass's lock first
 *   (`MEMORY_REVIEW_CLAIM_LOCK`), so the two queue instead of deadlocking.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import {
  FAILING_REVIEW_TURN,
  groupWithFailingReview,
  outcome,
  insertJournalRun,
  ownedExternalGroup,
} from "./memory-review/memory-review-dispatch.integration-fixtures.js";
import { memoryReviewDispatchRepository } from "./memory-review/memory-review-dispatch-repository.js";
import { memoryReviewTerminalRepository } from "./memory-review/memory-review-terminal-repository.js";
import { waitForLockWaiters } from "./person-cards/person-card-cleanup.integration-fixtures.js";
import { telegramGroupAdministrationRepository } from "./telegram-group-administration-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

const CHAT_ID = "-100-race";

/** Two topics, each with a turn abandoned hours ago; the second topic's is the older one. */
async function topicsWithAbandonedTurns() {
  const { conversationId, familyId, groupId, ownerId } = await ownedExternalGroup(CHAT_ID, 40);
  let olderBatchId = "";
  for (const [thread, base, startedHoursAgo] of [
    [11, 0, 2],
    [12, 20, 3],
  ] as const) {
    await insertJournalRun(groupId, base + 1, base + 20, thread);
    const lane = await database().query<{ id: string }>(
      `INSERT INTO memory_review_lanes (conversation_id, message_thread_id, processed_through_sequence)
       VALUES ($1, $2, $3) RETURNING id`,
      [conversationId, thread, base],
    );
    const batch = await database().query<{ id: string }>(
      `INSERT INTO memory_review_batches
         (lane_id, conversation_id, batch_kind, status, predecessor_sequence, from_sequence,
          through_sequence, source_count, eve_session_id, eve_turn_id, started_at)
       VALUES ($1, $2, 'background', 'running', $3::bigint, $3::bigint + 1, $3::bigint + 10, 10,
               'eve-' || $4::text, 'turn-' || $4::text, now() - $5 * interval '1 hour')
       RETURNING id`,
      [lane.rows[0]!.id, conversationId, base, thread, startedHoursAgo],
    );
    await database().query(
      `INSERT INTO memory_review_batch_sources
         (batch_id, conversation_id, timeline_entry_id, timeline_sequence)
       SELECT $1, $2, id, sequence_id FROM telegram_group_messages
        WHERE conversation_id = $2 AND sequence_id BETWEEN $3::int + 1 AND $3::int + 10`,
      [batch.rows[0]!.id, conversationId, base],
    );
    if (thread === 12) olderBatchId = batch.rows[0]!.id;
  }
  return { familyId, olderBatchId, ownerId };
}

describeWithDatabase("silent review turned back on during a failing review turn", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE telegram_groups, family_memberships, users, families CASCADE");
  });
  afterAll(async () => closeDatabase());

  it("lets both the policy update and the failure finish", async () => {
    const { batchId, familyId, ownerId } = await groupWithFailingReview(CHAT_ID);
    // Holds the failure after its lane lock, at the release of the batch's sources.
    const holder = await database().connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT 1 FROM memory_review_batch_sources WHERE batch_id = $1 FOR UPDATE",
        [batchId],
      );
      const failure = outcome(
        memoryReviewTerminalRepository.failRunning({
          batchId,
          diagnosticCode: "AGENT_MEMORY_REVIEW_TURN_FAILED",
          eveSessionId: FAILING_REVIEW_TURN.eveSessionId,
          eveTurnId: FAILING_REVIEW_TURN.eveTurnId,
        }),
      );
      await waitForLockWaiters(1);
      const update = outcome(
        telegramGroupAdministrationRepository.updatePolicy({
          familyId,
          memoryReview: true,
          messageMode: "all",
          requestedBy: ownerId,
          telegramChatId: CHAT_ID,
          toolAllowlist: [],
        }),
      );
      await waitForLockWaiters(2);
      await holder.query("COMMIT");

      expect(await Promise.all([failure, update])).toEqual(["ok", "ok"]);
    } finally {
      holder.release();
    }
  });

  it("queues the policy update behind a claim pass across two topics", async () => {
    const { familyId, olderBatchId, ownerId } = await topicsWithAbandonedTurns();
    const holder = await database().connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT 1 FROM memory_review_batch_sources WHERE batch_id = $1 FOR UPDATE",
        [olderBatchId],
      );
      const claim = outcome(
        memoryReviewDispatchRepository.claimPending({
          leaseMilliseconds: 60_000,
          limit: 5,
          now: new Date(),
        }),
      );
      await waitForLockWaiters(1);
      const update = outcome(
        telegramGroupAdministrationRepository.updatePolicy({
          familyId,
          memoryReview: true,
          messageMode: "all",
          requestedBy: ownerId,
          telegramChatId: CHAT_ID,
          toolAllowlist: [],
        }),
      );
      await waitForLockWaiters(2);
      await holder.query("COMMIT");

      expect(await Promise.all([claim, update])).toEqual(["ok", "ok"]);
    } finally {
      holder.release();
    }
  });
});
