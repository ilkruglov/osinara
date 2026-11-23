/**
 * Review turned back on starts at the journal's end: PostgreSQL integration tests.
 *
 * Constructs covered:
 * - `restartMemoryReviewAtJournalEnd` with `discardUnreachableReviewBatches`: a batch left on the old
 *   cursor is dropped by the next claim pass, not left pending forever; a batch leased before the
 *   restart is refused at dispatch and swept once its lease ends, with its unstarted session
 *   retired; a failed or ambiguous batch behind the cursor lets its sources go and keeps its record;
 *   the first batch after the restart shows no message from the time review was off as
 *   earlier context; a topic first seen while review was off starts at its end (final review,
 *   22 November 2026).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createMainAgentMemoryFixture } from "../memory-agent-write.integration-fixtures.js";
import { memoryReviewDispatchRepository } from "./memory-review-dispatch-repository.js";
import { observe, setReview } from "./memory-review-dispatch.integration-fixtures.js";
import { restartMemoryReviewAtJournalEnd } from "./memory-review-lane-restart.js";
import { memoryReviewSessionRepository } from "./memory-review-session-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
// Each test truncates users and families: only a database named *_test may take that.
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

/** What the owner's switch does when review goes from off to on. */
async function turnReviewBackOn(groupId: string): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE telegram_groups SET memory_review_enabled = true WHERE id = $1", [
      groupId,
    ]);
    await restartMemoryReviewAtJournalEnd(client, groupId);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const claim = (now: Date) =>
  memoryReviewDispatchRepository.claimPending({ leaseMilliseconds: 60_000, limit: 5, now });

/** A batch leased and its session prepared, then review switched off and back on. */
async function leaseThenRestart() {
  const fixture = await createMainAgentMemoryFixture();
  await observe(fixture, 2, 51);
  const [leased] = await claim(new Date());
  const prepared = await memoryReviewSessionRepository.prepare(leased!, new Date());
  await setReview(fixture.groupId, false);
  await turnReviewBackOn(fixture.groupId);
  return { fixture, leased: leased!, sessionId: prepared.id };
}

async function isRetired(sessionId: string): Promise<boolean | undefined> {
  const session = await database().query<{ retired: boolean }>(
    "SELECT retired_at IS NOT NULL AS retired FROM conversation_sessions WHERE id = $1",
    [sessionId],
  );
  return session.rows[0]?.retired;
}

async function batchCount(conversationId: string): Promise<number> {
  const result = await database().query<{ count: number }>(
    "SELECT count(*)::int AS count FROM memory_review_batches WHERE conversation_id = $1",
    [conversationId],
  );
  return result.rows[0]!.count;
}

describeWithDatabase("memory review turned back on", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("drops a batch left on the old cursor and reviews only what comes after", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await observe(fixture, 2, 51);
    expect(await batchCount(fixture.conversationId)).toBe(1);
    await setReview(fixture.groupId, false);
    await observe(fixture, 52, 60);

    await turnReviewBackOn(fixture.groupId);
    await expect(claim(new Date())).resolves.toEqual([]);
    expect(await batchCount(fixture.conversationId)).toBe(0);

    await observe(fixture, 61, 110);
    const [next] = await claim(new Date());
    expect(next?.sourceCount).toBe(50);
    expect(next?.entries[0]?.sequenceId).toBe("61");
  });

  // Repeat review, 23 November 2026: the sweep logged its drop before the pass committed, and a
  // pass that failed later rolled the drop back under a log that said it happened.
  it("logs the batches it dropped only once the pass commits", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await observe(fixture, 2, 51);
    await setReview(fixture.groupId, false);
    await observe(fixture, 52, 60);
    await turnReviewBackOn(fixture.groupId);
    await observe(fixture, 61, 110);
    // The batch at the new cursor lost a source it counts: the pass fails after its sweep.
    await database().query(
      `DELETE FROM memory_review_batch_sources
        WHERE timeline_sequence = 61
          AND batch_id IN (SELECT id FROM memory_review_batches WHERE conversation_id = $1)`,
      [fixture.conversationId],
    );
    const info = vi.spyOn(console, "info");
    try {
      await expect(claim(new Date())).rejects.toThrow("AGENT_MEMORY_REVIEW_SOURCE_SET_INVALID");
      const logged = info.mock.calls.some(([line]) =>
        String(line).includes("AGENT_MEMORY_REVIEW_BATCHES_DISCARDED"),
      );
      expect(logged).toBe(false);
      expect(await batchCount(fixture.conversationId)).toBe(2);
    } finally {
      info.mockRestore();
    }
  });

  it("refuses a batch leased before the restart and sweeps it once the lease ends", async () => {
    const { fixture, leased, sessionId } = await leaseThenRestart();

    await expect(
      memoryReviewDispatchRepository.markDispatchStarted(leased, sessionId),
    ).resolves.toBe(false);
    await memoryReviewSessionRepository.retireUnstarted(leased, sessionId);

    await expect(claim(new Date(Date.now() + 2 * 60_000))).resolves.toEqual([]);
    expect(await batchCount(fixture.conversationId)).toBe(0);
    expect(await isRetired(sessionId)).toBe(true);
  });

  it("sweeps a batch whose worker died after leasing it, with the session it prepared", async () => {
    const { fixture, sessionId } = await leaseThenRestart();

    // Still leased: its worker may be alive, so the batch waits for the lease to end.
    await expect(claim(new Date())).resolves.toEqual([]);
    expect(await batchCount(fixture.conversationId)).toBe(1);
    await expect(claim(new Date(Date.now() + 2 * 60_000))).resolves.toEqual([]);
    expect(await batchCount(fixture.conversationId)).toBe(0);
    expect(await isRetired(sessionId)).toBe(true);
  });

  it("releases the sources of a batch that failed behind the cursor, keeping its record", async () => {
    const { fixture, leased } = await leaseThenRestart();
    // The worker reached Eve before the restart and the outcome stayed unknown.
    await database().query(
      `UPDATE memory_review_batches
          SET status = 'ambiguous', lease_token = NULL, lease_expires_at = NULL,
              completed_at = now(), diagnostic_code = 'AGENT_MEMORY_REVIEW_TEST_AMBIGUOUS'
        WHERE id = $1`,
      [leased.batchId],
    );

    await expect(claim(new Date())).resolves.toEqual([]);
    const sources = await database().query<{ count: number }>(
      "SELECT count(*)::int AS count FROM memory_review_batch_sources WHERE batch_id = $1",
      [leased.batchId],
    );
    expect(sources.rows[0]!.count).toBe(0);
    expect(await batchCount(fixture.conversationId)).toBe(1);
  });

  it("shows the first batch after the restart nothing from the time review was off", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await setReview(fixture.groupId, false);
    await observe(fixture, 2, 30);
    await turnReviewBackOn(fixture.groupId);

    await observe(fixture, 31, 80);
    const [next] = await claim(new Date());
    expect(next?.entries[0]?.sequenceId).toBe("31");
    expect(next?.prompt).not.toMatch(/Сообщение памяти (?:[2-9]|[12]\d|30)(?!\d)/u);
  });

  it("starts a topic first seen while review was off at its end", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await setReview(fixture.groupId, false);
    await observe(fixture, 2, 16, 11);
    await turnReviewBackOn(fixture.groupId);

    // Seven hours of quiet would make the topic due by its idle rule, had anything been left.
    const later = () => new Date(Date.now() + 7 * 60 * 60 * 1000);
    await expect(claim(later())).resolves.toEqual([]);
    await observe(fixture, 17, 21, 11);
    const [next] = await claim(later());
    expect(next?.sourceCount).toBe(5);
    expect(next?.messageThreadId).toBe("11");
  });
});
