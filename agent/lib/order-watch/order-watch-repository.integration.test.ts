/**
 * Order watches in PostgreSQL (migration 140).
 *
 * Constructs covered:
 * - Starting twice keeps one active watch per order and person; stopping ends it.
 * - A due watch is claimed under a lease once; a chat with a message waiting or a turn running is
 *   left for a later tick; a watch of someone no longer in the family is ended instead.
 * - Writes under a lease another tick took change nothing; reschedule counts failures and resets
 *   them on success; finish ends the watch; old finished watches are purged.
 * - A message of the watch is recorded in the person's notification history as `order_watch`.
 * - The browser goes to a turn or to one background check at a time: a check only while the chat is
 *   idle and no turn marked it, a turn after the check released it or its hold expired.
 */
import { randomInt } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createMemoryFamilyFixture } from "../memory-repository.integration-fixtures.js";
import { browserHoldRepository } from "../browser/browser-hold.js";
import { proactiveDeliveryRepository } from "../proactive-deliveries/proactive-delivery-repository.js";
import { orderWatchRepository } from "./order-watch-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

async function busyChat(chatId: string, status: "pending" | "processing"): Promise<void> {
  const key = `telegram:order-watch:${chatId}`;
  const queue = await database().query<{ id: string }>(
    "INSERT INTO telegram_ingress_queues (current_continuation_key) VALUES ($1) RETURNING id", [key],
  );
  await database().query(
    `INSERT INTO telegram_ingress_updates (update_id, queue_id, ingress_continuation_key, payload, status, lease_token, lease_expires_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
    [randomInt(1_000_000_000, 2_000_000_000), queue.rows[0]!.id, key, JSON.stringify({ message: { chat: { id: Number(chatId), type: "private" }, text: "x" } }),
      status, status === "processing" ? "00000000-0000-4000-8000-000000000011" : null, status === "processing" ? new Date(Date.now() + 60_000) : null],
  );
}

describeWithDatabase("orderWatchRepository", () => {
  afterAll(closeDatabase);

  it("keeps one active watch per order, claims it once, skips a busy chat and honours the lease", async () => {
    const family = await createMemoryFamilyFixture(`order-watch-${Date.now()}`);
    const userId = family.owner.userId!;
    const chatId = String(randomInt(100_000_000, 900_000_000));
    const now = new Date();
    const base = { familyId: family.familyId, initialState: null, now, sandboxSessionId: "thread-1", service: "yandex_taxi" as const, telegramChatId: chatId, userId };

    const first = await orderWatchRepository.start({ ...base, orderId: "o-1" });
    const again = await orderWatchRepository.start({ ...base, orderId: "o-1" });
    expect(first.created).toBe(true);
    expect(again).toEqual({ created: false, id: first.id });
    await expect(orderWatchRepository.active({ service: "yandex_taxi", userId })).resolves.toEqual(["o-1"]);

    const later = new Date(now.getTime() + 1_000);
    const claimed = (await orderWatchRepository.claimDue({ leaseMilliseconds: 60_000, limit: 50, now: later })).filter((watch) => watch.id === first.id);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ failures: 0, lastState: null, orderId: "o-1", sandboxSessionId: "thread-1", telegramChatId: chatId });
    expect((await orderWatchRepository.claimDue({ leaseMilliseconds: 60_000, limit: 50, now: later })).some((watch) => watch.id === first.id)).toBe(false);

    const watch = claimed[0]!;
    await orderWatchRepository.saveState(watch, { status: "driving" });
    await orderWatchRepository.reschedule(watch, { errorCode: "AGENT_BROWSER_TIMEOUT", nextCheckAt: later, state: null });
    await expect(orderWatchRepository.saveState(watch, { status: "waiting" })).rejects.toMatchObject({ code: "AGENT_ORDER_WATCH_LEASE_STALE" });

    // A message waiting in the chat holds the watch back; once it is done, the watch is due again.
    await busyChat(chatId, "pending");
    expect((await orderWatchRepository.claimDue({ leaseMilliseconds: 60_000, limit: 50, now: later })).some((w) => w.id === first.id)).toBe(false);
    await database().query("UPDATE telegram_ingress_updates SET status = 'completed', completed_at = now() WHERE payload #>> '{message,chat,id}' = $1", [chatId]);
    const retaken = (await orderWatchRepository.claimDue({ leaseMilliseconds: 60_000, limit: 50, now: later })).find((w) => w.id === first.id)!;
    expect(retaken).toMatchObject({ failures: 1, lastState: { status: "driving" } });

    await orderWatchRepository.reschedule(retaken, { errorCode: null, nextCheckAt: later, state: { status: "waiting" } });
    const third = (await orderWatchRepository.claimDue({ leaseMilliseconds: 60_000, limit: 50, now: later })).find((w) => w.id === first.id)!;
    expect(third).toMatchObject({ failures: 0, lastState: { status: "waiting" } });

    await proactiveDeliveryRepository.record({
      content: "Такси на месте: Белый Kia Rio, А123ВС777.", deliveredAt: later, familyId: family.familyId, groupId: null, messageThreadId: null,
      ownerUserId: userId, scheduledFor: later, scope: "personal", sourceId: third.id, sourceKind: "order_watch", telegramChatId: chatId, telegramMessageId: "901", title: "Такси",
    });
    const recorded = await database().query("SELECT source_kind FROM proactive_deliveries WHERE source_id = $1", [third.id]);
    expect(recorded.rows).toEqual([{ source_kind: "order_watch" }]);

    await orderWatchRepository.finish(third, { errorCode: null, reason: "order_ended", state: { status: "complete" } });
    await expect(orderWatchRepository.active({ service: "yandex_taxi", userId })).resolves.toEqual([]);
    await expect(orderWatchRepository.start({ ...base, orderId: "o-1" })).resolves.toMatchObject({ created: true });
    await expect(orderWatchRepository.stop({ orderId: "o-1", service: "yandex_taxi", userId })).resolves.toBe(1);

    await database().query("UPDATE order_watches SET finished_at = now() - interval '31 days' WHERE id = $1", [first.id]);
    await expect(orderWatchRepository.purgeFinished(new Date())).resolves.toBeGreaterThanOrEqual(1);
    const left = await database().query("SELECT 1 FROM order_watches WHERE id = $1", [first.id]);
    expect(left.rowCount).toBe(0);
  });

  it("gives the browser to a turn or to one background check at a time", async () => {
    const chatId = String(randomInt(100_000_000, 900_000_000));
    const sandboxSessionId = `thread-hold-${chatId}`;
    const first = { holder: "00000000-0000-4000-8000-0000000000a1", sandboxSessionId };
    await expect(browserHoldRepository.tryHold({ ...first, idleChatId: chatId, ttlMs: 60_000 })).resolves.toBe(true);
    await expect(browserHoldRepository.holdsStill(first)).resolves.toBe(true);
    await expect(browserHoldRepository.tryHold({ holder: "00000000-0000-4000-8000-0000000000a2", idleChatId: chatId, sandboxSessionId, ttlMs: 60_000 })).resolves.toBe(false);

    // A turn's command waits for the check, then marks the browser as the turn's.
    let entered = false;
    const turn = browserHoldRepository.enterAsTurn(sandboxSessionId).then(() => { entered = true; });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(entered).toBe(false);
    await browserHoldRepository.release(first);
    await turn;
    await expect(browserHoldRepository.holdsStill(first)).resolves.toBe(false);
    // While the turn's mark is live, no check takes the browser, even with no message in the queue.
    await expect(browserHoldRepository.tryHold({ ...first, idleChatId: chatId, ttlMs: 60_000 })).resolves.toBe(false);
    await browserHoldRepository.enterAsTurn(sandboxSessionId);

    // A chat with a turn running keeps checks away even before the turn touches the browser.
    const busy = String(randomInt(100_000_000, 900_000_000));
    await busyChat(busy, "processing");
    await expect(browserHoldRepository.tryHold({ ...first, idleChatId: busy, sandboxSessionId: `thread-hold-${busy}`, ttlMs: 60_000 })).resolves.toBe(false);
    // An expired hold of a crashed check is taken over, by a check or by a turn.
    const other = String(randomInt(100_000_000, 900_000_000));
    await database().query("INSERT INTO sandbox_browser_holds VALUES ($1, '00000000-0000-4000-8000-0000000000a3', 'background', now() - interval '1 second')", [`thread-hold-${other}`]);
    await expect(browserHoldRepository.tryHold({ holder: "00000000-0000-4000-8000-0000000000a4", idleChatId: other, sandboxSessionId: `thread-hold-${other}`, ttlMs: 60_000 })).resolves.toBe(true);
    await database().query("UPDATE sandbox_browser_holds SET expires_at = now() - interval '1 second' WHERE sandbox_session_id = $1", [`thread-hold-${other}`]);
    await browserHoldRepository.enterAsTurn(`thread-hold-${other}`);
  });

  it("ends the watch of someone who left the family instead of looking at their order", async () => {
    const family = await createMemoryFamilyFixture(`order-watch-left-${Date.now()}`);
    const userId = family.member.userId!;
    const now = new Date();
    const started = await orderWatchRepository.start({
      familyId: family.familyId, initialState: null, now, orderId: "l-1", sandboxSessionId: "thread-2", service: "yandex_lavka",
      telegramChatId: String(randomInt(100_000_000, 900_000_000)), userId,
    });
    await database().query("DELETE FROM family_memberships WHERE family_id = $1 AND user_id = $2", [family.familyId, userId]);
    const claimed = await orderWatchRepository.claimDue({ leaseMilliseconds: 60_000, limit: 50, now: new Date(now.getTime() + 1_000) });
    expect(claimed.some((watch) => watch.id === started.id)).toBe(false);
    const row = await database().query<{ finish_reason: string; status: string }>("SELECT status, finish_reason FROM order_watches WHERE id = $1", [started.id]);
    expect(row.rows[0]).toEqual({ finish_reason: "stopped", status: "finished" });
  });
});
