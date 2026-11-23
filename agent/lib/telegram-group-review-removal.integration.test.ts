/**
 * A group with an open silent review batch or a turn in progress can still be removed or change
 * its type.
 *
 * Constructs covered:
 * - `removeRegistration` and a type-changing `registerGroup` delete the group's journal by cascade
 *   while a review batch holds its messages as sources (pending, leased or running, or a failed
 *   head for up to an hour; for good when review was switched off with a batch left at the cursor)
 *   and a turn's memory binding holds the current message and the ones it saw. Those references
 *   had no delete action, and the owner got a raw foreign-key error (repeat review, 23 November
 *   2026); migration 150 deletes them with the message.
 * - While a review turn of the group fails (`failRunning`, or the claim pass resolving an abandoned
 *   turn), the failure holds its batch and lane and then alerts the owner with a row referencing
 *   the group, and the removal holds the group and then waits for the lane in its cascade: one of
 *   them is aborted with `40P01`. The removal and the type change retry once, so the owner's
 *   command goes through. The interleaving is forced by a third connection, and repeated until the
 *   command, not the review, is the side aborted: the retry itself is what is proven.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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

/**
 * Runs of the owner's command in a round (two prove the retry ran, not just a lucky race) and the
 * runs it allows: the retry may meet the review's next lock again (repeat review, 23 November 2026).
 */
const retries = vi.hoisted(() => ({ allowed: 0, attempts: 0 }));
vi.mock("./transaction-conflict-retry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transaction-conflict-retry.js")>();
  return {
    ...actual,
    retryOnTransactionConflict: <T>(run: () => Promise<T>, attempts?: number): Promise<T> => {
      retries.allowed = attempts ?? 2;
      return actual.retryOnTransactionConflict(() => {
        retries.attempts += 1;
        return run();
      }, attempts);
    },
  };
});

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

const CHAT_ID = "-100-removal";
const SOURCE_TABLES = [
  "telegram_group_messages",
  "memory_review_batch_sources",
  "memory_turn_source_sets",
  "memory_turn_sources",
] as const;

/**
 * Twenty messages: a pending batch left at the cursor holds the first ten as its sources, and a
 * turn in progress is bound to the last ten, the twentieth its current message.
 */
async function groupWithOpenSources(): Promise<{ familyId: string; ownerId: string }> {
  const { conversationId, familyId, groupId, ownerId } = await ownedExternalGroup(CHAT_ID, 20);
  await insertJournalRun(groupId, 1, 20);
  const lane = await database().query<{ id: string }>(
    `INSERT INTO memory_review_lanes (conversation_id, message_thread_id, processed_through_sequence)
     VALUES ($1, NULL, 0) RETURNING id`,
    [conversationId],
  );
  const batch = await database().query<{ id: string }>(
    `INSERT INTO memory_review_batches
       (lane_id, conversation_id, batch_kind, status, predecessor_sequence, from_sequence,
        through_sequence, source_count)
     VALUES ($1, $2, 'background', 'pending', 0, 1, 10, 10) RETURNING id`,
    [lane.rows[0]!.id, conversationId],
  );
  await database().query(
    `INSERT INTO memory_review_batch_sources
       (batch_id, conversation_id, timeline_entry_id, timeline_sequence)
     SELECT $1, $2, id, sequence_id FROM telegram_group_messages
      WHERE conversation_id = $2 AND sequence_id BETWEEN 1 AND 10`,
    [batch.rows[0]!.id, conversationId],
  );
  const session = await database().query<{ id: string }>(
    `INSERT INTO conversation_sessions
       (thread_id, generation, family_id, group_id, scope, kind, conversation_key,
        continuation_token, started_at, last_activity_at)
     VALUES (gen_random_uuid(), 0, $1, $2, 'group', 'canonical', 'removal-turn', 'removal-turn',
             now(), now()) RETURNING id`,
    [familyId, groupId],
  );
  await database().query(
    `INSERT INTO memory_turn_source_sets
       (eve_session_id, eve_turn_id, application_session_id, conversation_id,
        current_timeline_entry_id, invoking_actor_id, invoking_actor_kind, binding_hash)
     SELECT 'eve-removal', 'turn-removal', $1, $2, id, 'u', 'telegram_user', repeat('a', 64)
       FROM telegram_group_messages WHERE conversation_id = $2 AND sequence_id = 20`,
    [session.rows[0]!.id, conversationId],
  );
  await database().query(
    `INSERT INTO memory_turn_sources
       (eve_session_id, eve_turn_id, conversation_id, timeline_entry_id, timeline_sequence,
        is_current)
     SELECT 'eve-removal', 'turn-removal', $1, id, sequence_id, sequence_id = 20
       FROM telegram_group_messages WHERE conversation_id = $1 AND sequence_id > 10`,
    [conversationId],
  );
  return { familyId, ownerId };
}

/** The owner's command: removing the group, or registering it again as a family group. */
function ownerCommand(action: "remove" | "retype", familyId: string, ownerId: string) {
  return action === "remove"
    ? telegramGroupAdministrationRepository.removeRegistration({
        familyId,
        requestedBy: ownerId,
        telegramChatId: CHAT_ID,
      })
    : telegramGroupAdministrationRepository.registerGroup({
        familyId,
        messageMode: "all",
        requestedBy: ownerId,
        telegramChatId: CHAT_ID,
        title: "Семья",
        toolAllowlist: [],
        type: "family_private",
      });
}

/** Rounds a race may take before the command is the side aborted: odds of none ~0.7^40. */
const RACE_ROUNDS = 40;

/**
 * One forced interleaving: a third connection holds the failure after its lane lock, at the release
 * of the batch's sources, until the owner's command waits on that lane. Returns the command's
 * outcome; the review side may be the one aborted, its group gone either way.
 */
async function raceOnce(
  action: "remove" | "retype",
  failure: "turn failure" | "claim pass",
): Promise<string> {
  const { batchId, familyId, ownerId } = await groupWithFailingReview(
    CHAT_ID,
    failure === "claim pass" ? 3 : 0,
  );
  const holder = await database().connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM memory_review_batch_sources WHERE batch_id = $1 FOR UPDATE", [
      batchId,
    ]);
    const review = outcome(
      failure === "claim pass"
        ? memoryReviewDispatchRepository.claimPending({
            leaseMilliseconds: 60_000,
            limit: 5,
            now: new Date(),
          })
        : memoryReviewTerminalRepository.failRunning({
            batchId,
            diagnosticCode: "AGENT_MEMORY_REVIEW_TURN_FAILED",
            ...FAILING_REVIEW_TURN,
          }),
    );
    await waitForLockWaiters(1);
    const command = outcome(ownerCommand(action, familyId, ownerId));
    await waitForLockWaiters(2);
    await holder.query("COMMIT");
    await review;
    return await command;
  } finally {
    holder.release();
  }
}

async function expectSourcesGone(): Promise<void> {
  for (const table of SOURCE_TABLES) {
    const result = await database().query<{ count: string }>(`SELECT count(*) FROM ${table}`);
    expect(Number(result.rows[0]!.count), table).toBe(0);
  }
}

describeWithDatabase("a group whose journal review and a turn still hold", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE telegram_groups, family_memberships, users, families CASCADE");
  });
  afterAll(async () => closeDatabase());

  it("is removed with its journal and every source", async () => {
    const { familyId, ownerId } = await groupWithOpenSources();

    await ownerCommand("remove", familyId, ownerId);

    await expectSourcesGone();
  });

  it("changes its type, the old trust zone's journal and sources gone", async () => {
    const { familyId, ownerId } = await groupWithOpenSources();

    await ownerCommand("retype", familyId, ownerId);

    await expectSourcesGone();
  });

  for (const action of ["remove", "retype"] as const) {
    for (const failure of ["turn failure", "claim pass"] as const) {
      // PostgreSQL picks which side of the deadlock it aborts; when it picks the review, the
      // command passes with no retry at all. The race runs until the command was the one aborted
      // and retried, so the test fails without the retry (repeat review, 23 November 2026: one run
      // in ten passed with the retry removed).
      it(`${action}s it while a ${failure} of its review turn alerts the owner`, async () => {
        let retried = false;
        for (let round = 0; round < RACE_ROUNDS && !retried; round += 1) {
          await database().query(
            "TRUNCATE telegram_groups, family_memberships, users, families CASCADE",
          );
          retries.attempts = 0;
          expect(await raceOnce(action, failure)).toBe("ok");
          retried = retries.attempts > 1;
        }
        expect(retried).toBe(true);
        expect(retries.allowed).toBe(3);
      }, 120_000);
    }
  }
});
