/**
 * Telegram chat reachability repository tests (PostgreSQL, migration 138).
 *
 * Constructs covered:
 * - A delivery failure marks a chat and keeps its first moment; a message clears it.
 * - A 403 to a send that started before a message, an unblock or a return to the group was received
 *   is stale and marks nothing, also for a chat that had no row before the message.
 * - `my_chat_member` marks and clears in update order: an older or repeated update changes nothing.
 * - A message not newer than the last membership change (by date, then by update id) clears nothing.
 * - A removal older than the last proof (a message, an unblock) by (Telegram date, update id) is late and
 *   marks nothing; a later date wins even with a smaller update id (ids restart after a quiet week).
 * - The table refuses an empty chat id and an unknown reason.
 */
import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { telegramReachabilityRepository as repository } from "./reachability-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

let next = Date.now() % 1_000_000_000;
const chatId = (group = false) => `${group ? "-100" : ""}${(next += 1)}`;
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 24, 6, 0, seconds));
const message = (id: string, sentSeconds: number, updateId: string, receivedSeconds = sentSeconds) =>
  repository.recordInboundMessage({ chatId: id, receivedAt: at(receivedSeconds), sentAt: at(sentSeconds), updateId });

async function row(id: string) {
  return (await database().query<{ source: string; unreachable_reason: string | null; unreachable_since: Date | null }>(
    "SELECT source, unreachable_reason, unreachable_since FROM telegram_chat_reachability WHERE telegram_chat_id = $1",
    [id],
  )).rows[0];
}

describeWithDatabase("telegramReachabilityRepository", () => {
  afterAll(closeDatabase);

  it("marks a chat on a classified failure, keeps the first moment and clears it on a message", async () => {
    const id = chatId();
    await expect(repository.unreachableReason(id)).resolves.toBeNull();

    await expect(repository.markUndeliverable(id, "blocked", at(1))).resolves.toBe(true);
    const first = await row(id);
    await expect(repository.markUndeliverable(id, "deactivated", at(2))).resolves.toBe(true);

    expect(await row(id)).toEqual({ source: "delivery", unreachable_reason: "deactivated", unreachable_since: first!.unreachable_since });
    await expect(repository.unreachableReason(id)).resolves.toBe("deactivated");
    await expect(message(id, 3, "100")).resolves.toEqual({ cleared: true });
    await expect(message(id, 4, "101")).resolves.toEqual({ cleared: false });
    expect(await row(id)).toMatchObject({ source: "inbound_message", unreachable_reason: null, unreachable_since: null });
  });

  it("ignores a 403 to a send that started before a message from the chat was received", async () => {
    const id = chatId();
    // The send left at :10, the person wrote at :11 (the chat had no row), the old 403 came at :12.
    await expect(message(id, 11, "200")).resolves.toEqual({ cleared: false });
    await expect(repository.markUndeliverable(id, "blocked", at(10))).resolves.toBe(false);
    await expect(repository.unreachableReason(id)).resolves.toBeNull();
    // A send that started after that message is Telegram's newer word.
    await expect(repository.markUndeliverable(id, "blocked", at(12))).resolves.toBe(true);
    await expect(repository.unreachableReason(id)).resolves.toBe("blocked");
  });

  it("ignores a 403 to a send that started before an unblock or a return to the group was received", async () => {
    const person = chatId();
    await repository.applyMembershipChange({ changedAt: at(1), chatId: person, reason: "blocked", receivedAt: at(1), updateId: "300" });
    await repository.applyMembershipChange({ changedAt: at(5), chatId: person, reason: null, receivedAt: at(6), updateId: "301" });
    await expect(repository.markUndeliverable(person, "blocked", at(4))).resolves.toBe(false);
    await expect(repository.unreachableReason(person)).resolves.toBeNull();

    const group = chatId(true);
    await repository.applyMembershipChange({ changedAt: at(7), chatId: group, reason: null, receivedAt: at(8), updateId: "302" });
    await expect(repository.markUndeliverable(group, "kicked", at(7))).resolves.toBe(false);
    await expect(repository.markUndeliverable(group, "kicked", at(9))).resolves.toBe(true);
  });

  it("applies membership changes in Telegram's order, whatever order they arrive in", async () => {
    const id = chatId(true);

    // The bot came back at :05 after a removal at :01; the removal is delivered last.
    await expect(repository.applyMembershipChange({ changedAt: at(5), chatId: id, reason: null, receivedAt: at(20), updateId: "20" })).resolves.toBe(true);
    await expect(repository.applyMembershipChange({ changedAt: at(1), chatId: id, reason: "kicked", receivedAt: at(21), updateId: "10" })).resolves.toBe(false);
    await expect(repository.unreachableReason(id)).resolves.toBeNull();

    await expect(repository.applyMembershipChange({ changedAt: at(9), chatId: id, reason: "not_member", receivedAt: at(22), updateId: "30" })).resolves.toBe(true);
    // A repeated delivery of the same update is not newer than itself.
    await expect(repository.applyMembershipChange({ changedAt: at(9), chatId: id, reason: "not_member", receivedAt: at(23), updateId: "30" })).resolves.toBe(false);
    await expect(repository.unreachableReason(id)).resolves.toBe("not_member");
    expect(await row(id)).toMatchObject({ source: "membership_update" });

    // A message written before that removal proves nothing about it; one written after does.
    await expect(message(id, 8, "29", 24)).resolves.toBeNull();
    await expect(message(id, 10, "31", 25)).resolves.toEqual({ cleared: true });
    await expect(repository.unreachableReason(id)).resolves.toBeNull();
  });

  it("orders a message with the same date as the removal by update id", async () => {
    const id = chatId(true);
    await repository.applyMembershipChange({ changedAt: at(30), chatId: id, reason: "kicked", receivedAt: at(30), updateId: "500" });

    await expect(message(id, 30, "499")).resolves.toBeNull();
    await expect(message(id, 30, "500")).resolves.toBeNull();
    await expect(repository.unreachableReason(id)).resolves.toBe("kicked");
    await expect(message(id, 30, "501")).resolves.toEqual({ cleared: true });
  });

  it("ignores a removal delivered late after a newer message or unblock, by update id", async () => {
    const group = chatId(true);
    await expect(message(group, 10, "20")).resolves.toEqual({ cleared: false });
    await expect(repository.applyMembershipChange({ changedAt: at(9), chatId: group, reason: "kicked", receivedAt: at(12), updateId: "19" }))
      .resolves.toBe(false);
    await expect(repository.unreachableReason(group)).resolves.toBeNull();
    // A removal that came after the message is Telegram's newer word.
    await expect(repository.applyMembershipChange({ changedAt: at(11), chatId: group, reason: "kicked", receivedAt: at(13), updateId: "21" }))
      .resolves.toBe(true);
    await expect(repository.unreachableReason(group)).resolves.toBe("kicked");

    const person = chatId();
    await repository.applyMembershipChange({ changedAt: at(1), chatId: person, reason: "blocked", receivedAt: at(1), updateId: "40" });
    await repository.applyMembershipChange({ changedAt: at(5), chatId: person, reason: null, receivedAt: at(5), updateId: "42" });
    await expect(repository.applyMembershipChange({ changedAt: at(5), chatId: person, reason: "blocked", receivedAt: at(6), updateId: "41" }))
      .resolves.toBe(false);
    await expect(repository.unreachableReason(person)).resolves.toBeNull();
  });

  it("orders a removal against the last proof by Telegram date first, then by update id", async () => {
    // (а) message date 100 id 20, then a late removal date 99 id 19: the chat stays reachable.
    const late = chatId(true);
    await message(late, 100, "20");
    await expect(repository.applyMembershipChange({ changedAt: at(99), chatId: late, reason: "kicked", receivedAt: at(120), updateId: "19" }))
      .resolves.toBe(false);
    await expect(repository.unreachableReason(late)).resolves.toBeNull();

    // (б) message date 100 id 500, then a removal date 101 id 7 after the ids restarted: it applies.
    const restarted = chatId(true);
    await message(restarted, 100, "500");
    await expect(repository.applyMembershipChange({ changedAt: at(101), chatId: restarted, reason: "not_member", receivedAt: at(121), updateId: "7" }))
      .resolves.toBe(true);
    await expect(repository.unreachableReason(restarted)).resolves.toBe("not_member");

    // (в) the same date: the update id decides.
    const sameDate = chatId(true);
    await message(sameDate, 100, "20");
    await expect(repository.applyMembershipChange({ changedAt: at(100), chatId: sameDate, reason: "kicked", receivedAt: at(122), updateId: "19" }))
      .resolves.toBe(false);
    await expect(repository.unreachableReason(sameDate)).resolves.toBeNull();
    await expect(repository.applyMembershipChange({ changedAt: at(100), chatId: sameDate, reason: "kicked", receivedAt: at(123), updateId: "21" }))
      .resolves.toBe(true);
    await expect(repository.unreachableReason(sameDate)).resolves.toBe("kicked");
  });

  it("keeps the newer proof as one pair, never mixing the date of one with the id of another", async () => {
    const group = chatId(true);
    await message(group, 100, "20");
    // An older message with a larger id (written before the ids restarted) does not replace the proof.
    await message(group, 90, "30");
    // Against the proof (100, 20) a removal (100, 25) is newer; a mixed (100, 30) would hide it.
    await expect(repository.applyMembershipChange({ changedAt: at(100), chatId: group, reason: "kicked", receivedAt: at(130), updateId: "25" }))
      .resolves.toBe(true);
    await expect(repository.unreachableReason(group)).resolves.toBe("kicked");
  });

  it("refuses an empty chat id and an unknown reason", async () => {
    await expect(repository.markUndeliverable("", "blocked", at(0))).rejects.toThrow();
    await expect(repository.markUndeliverable(chatId(), "gone" as never, at(0))).rejects.toThrow();
  });
});
