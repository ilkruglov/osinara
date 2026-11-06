/**
 * Whisper placeholder repository against PostgreSQL (migration 144).
 *
 * Constructs covered:
 * - A transition applies only from the statuses it names and reports a refused or missing one; an
 *   answer may replace a failure, a failure never replaces an answer.
 * - A settlement clears only the content it was made for; a newer change survives an older result.
 * - An unconfirmed edit waits with a growing delay and is dropped after the fifth attempt.
 * - Due edits are leased: a second claim does not return them again at once.
 * - Stale: an open placeholder no stored update carries (none, or one carrying another
 *   placeholder) is an orphan; one whose update ended over two minutes ago is unanswered; one whose
 *   update is still queued, or that is no longer open, is left alone.
 */
import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { whisperPlaceholderRepository as repository } from "./whisper-placeholder-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

let next = (Date.now() % 1_000_000) * 1000;
const fresh = () => {
  next += 1;
  return { chatId: `-100${next}`, placeholderMessageId: 31, receiverUserId: "101", updateId: String(9_000_000_000 + next) };
};
const keyOf = (record: ReturnType<typeof fresh>) => ({
  chatId: record.chatId, placeholderMessageId: record.placeholderMessageId, receiverUserId: record.receiverUserId,
});
const ANSWER = { format: "plain" as const, text: "Да." };

async function row(record: ReturnType<typeof fresh>) {
  return (await database().query<{ attempt_count: number; pending_content: unknown; status: string; waits_seconds: number | null }>(
    `SELECT status, pending_content, attempt_count,
            round(extract(epoch FROM next_attempt_at - now()))::integer AS waits_seconds
       FROM telegram_whisper_placeholders WHERE telegram_chat_id = $1 AND placeholder_message_id = $2`,
    [record.chatId, record.placeholderMessageId],
  )).rows[0];
}

async function age(record: ReturnType<typeof fresh>, seconds: number) {
  await database().query(
    `UPDATE telegram_whisper_placeholders SET created_at = now() - ($3::integer * interval '1 second')
      WHERE telegram_chat_id = $1 AND placeholder_message_id = $2`,
    [record.chatId, record.placeholderMessageId, seconds],
  );
}

// Stored updates are removed afterwards: a pending one would be claimed by other ingress tests.
const storedUpdates: string[] = [];

async function storeUpdate(record: ReturnType<typeof fresh>, status: "completed" | "pending", placeholderMessageId: number, endedSecondsAgo = 0) {
  const queue = await database().query<{ id: string }>(
    `INSERT INTO telegram_ingress_queues (current_continuation_key) VALUES ($1) RETURNING id`,
    [`telegram:whisper:${record.chatId}:${record.receiverUserId}`],
  );
  storedUpdates.push(record.updateId);
  await database().query(
    `INSERT INTO telegram_ingress_updates (update_id, queue_id, ingress_continuation_key, payload, status, completed_at)
     VALUES ($1::bigint, $2, $3, $4::jsonb, $5, CASE WHEN $5 = 'completed' THEN now() - ($6::integer * interval '1 second') END)`,
    [
      record.updateId,
      queue.rows[0]!.id,
      `telegram:whisper:${record.chatId}:${record.receiverUserId}`,
      JSON.stringify({ message: { osinara_whisper: { ephemeralMessageId: 7, placeholderMessageId, receiverUserId: record.receiverUserId } }, update_id: Number(record.updateId) }),
      status,
      endedSecondsAgo,
    ],
  );
}

describeWithDatabase("whisperPlaceholderRepository", () => {
  afterAll(async () => {
    const queues = await database().query<{ queue_id: string }>(
      "DELETE FROM telegram_ingress_updates WHERE update_id = ANY($1::bigint[]) RETURNING queue_id",
      [storedUpdates],
    );
    await database().query("DELETE FROM telegram_ingress_queues WHERE id = ANY($1::uuid[])", [queues.rows.map((queue) => queue.queue_id)]);
    await closeDatabase();
  });

  it("applies a transition only from the named statuses", async () => {
    const record = fresh();
    await repository.record(record);
    await repository.record(record);

    await expect(repository.transition(keyOf(record), { content: ANSWER, from: ["open", "progress", "failed"], to: "answered" })).resolves.toBe("applied");
    expect(await row(record)).toMatchObject({ attempt_count: 0, pending_content: ANSWER, status: "answered" });
    await expect(repository.transition(keyOf(record), { content: { format: "plain", text: "Сбой" }, from: ["open", "progress"], to: "failed" }))
      .resolves.toBe("refused");
    await expect(repository.transition({ ...keyOf(record), placeholderMessageId: 99 }, { content: ANSWER, from: ["open"], to: "answered" }))
      .resolves.toBe("missing");
    // A different receiver never matches the record.
    await expect(repository.transition({ ...keyOf(record), receiverUserId: "202" }, { content: ANSWER, from: ["answered"], to: "answered" }))
      .resolves.toBe("missing");
  });

  it("settles only the content it was made for", async () => {
    const record = fresh();
    await repository.record(record);
    const progress = { content: { format: "plain" as const, text: "Смотрю." }, to: "progress" as const };
    await repository.transition(keyOf(record), { ...progress, from: ["open"] });
    await repository.transition(keyOf(record), { content: ANSWER, from: ["progress"], to: "answered" });

    await expect(repository.settle(keyOf(record), progress, { outcome: "delivered" })).resolves.toBe("superseded");
    expect((await row(record))?.pending_content).toEqual(ANSWER);
    await expect(repository.settle(keyOf(record), { content: ANSWER, to: "answered" }, { outcome: "delivered" })).resolves.toBe("final");
    expect(await row(record)).toMatchObject({ pending_content: null, status: "answered", waits_seconds: null });
  });

  it("waits longer after each unconfirmed attempt and drops the edit after the fifth", async () => {
    const record = fresh();
    await repository.record(record);
    await repository.transition(keyOf(record), { content: { remove: true }, from: ["open"], to: "answered" });
    const change = { content: { remove: true as const }, to: "answered" as const };

    await expect(repository.settle(keyOf(record), change, { errorCode: "TELEGRAM_502", outcome: "retry" })).resolves.toBe("waiting");
    expect(await row(record)).toMatchObject({ attempt_count: 1, waits_seconds: 60 });
    await repository.settle(keyOf(record), change, { errorCode: "TELEGRAM_502", outcome: "retry" });
    expect(await row(record)).toMatchObject({ attempt_count: 2, waits_seconds: 120 });
    for (let attempt = 3; attempt < 5; attempt += 1) await repository.settle(keyOf(record), change, { errorCode: "TELEGRAM_502", outcome: "retry" });
    await expect(repository.settle(keyOf(record), change, { errorCode: "TELEGRAM_502", outcome: "retry" })).resolves.toBe("final");
    expect(await row(record)).toMatchObject({ attempt_count: 5, pending_content: null, waits_seconds: null });
  });

  it("leases a due edit so the next claim does not return it at once", async () => {
    const record = fresh();
    await repository.record(record);
    await repository.transition(keyOf(record), { content: ANSWER, from: ["open"], to: "answered" });
    await database().query(
      `UPDATE telegram_whisper_placeholders SET next_attempt_at = now() - interval '1 second' WHERE telegram_chat_id = $1`,
      [record.chatId],
    );

    const first = await repository.claimDue(1000);
    expect(first.filter((due) => due.chatId === record.chatId)).toEqual([
      { ...keyOf(record), attemptCount: 0, content: ANSWER, status: "answered" },
    ]);
    const second = await repository.claimDue(1000);
    expect(second.filter((due) => due.chatId === record.chatId)).toEqual([]);
    expect((await row(record))?.waits_seconds).toBe(120);
  });

  it("finds orphan and unanswered placeholders and leaves the rest", async () => {
    const neverStored = fresh();
    const redelivered = fresh();
    const unanswered = fresh();
    const justEnded = fresh();
    const queued = fresh();
    const answered = fresh();
    const young = fresh();
    for (const record of [neverStored, redelivered, unanswered, justEnded, queued, answered, young]) await repository.record(record);
    for (const record of [neverStored, redelivered, unanswered, justEnded, queued, answered]) await age(record, 600);
    await storeUpdate(redelivered, "pending", 77);
    await storeUpdate(unanswered, "completed", 31, 300);
    await storeUpdate(justEnded, "completed", 31, 10);
    await storeUpdate(queued, "pending", 31);
    await storeUpdate(answered, "completed", 31, 300);
    await repository.transition(keyOf(answered), { content: ANSWER, from: ["open"], to: "answered" });
    await repository.settle(keyOf(answered), { content: ANSWER, to: "answered" }, { outcome: "delivered" });

    const stale = (await repository.listStale(1000)).filter((placeholder) =>
      [neverStored, redelivered, unanswered, justEnded, queued, answered, young].some((record) => record.chatId === placeholder.chatId));

    expect(stale).toEqual(expect.arrayContaining([
      { ...keyOf(neverStored), reason: "orphan" },
      { ...keyOf(redelivered), reason: "orphan" },
      { ...keyOf(unanswered), reason: "unanswered" },
    ]));
    expect(stale).toHaveLength(3);
  });
});
