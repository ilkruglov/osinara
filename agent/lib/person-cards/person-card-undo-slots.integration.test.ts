/**
 * Undo of the person card cleanup and memory slots, against PostgreSQL.
 *
 * Constructs covered:
 * - Records that stood beside the cleaned one when it was cleaned (its kept record above all) do
 *   not keep it hidden: a repeat kept by a record of its own slot, a record refuted by a newer
 *   one of its slot, a repeat with the kept record's words in another slot all come back.
 * - Two records of one slot cleaned by one build both come back; so do two that stood together
 *   and two builds hid in either order.
 * - A record whose cleanup the publish skipped stays unread: the profile block shows it.
 * - Two versions of one slot hidden by two builds: only the newest comes back.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { memoryRepository } from "../memory-repository.js";
import { undoPersonCardCleanups } from "./person-card-cleanup-undo.js";
import {
  claimOwnerBuild,
  insertOwnerRecord,
  ownerPublishInput,
  publishOwnerCleanup,
} from "./person-card-cleanup.integration-fixtures.js";
import { publishPersonCard } from "./person-card-publish-repository.js";
import {
  createPersonCardFixture,
  resetPersonCardTables,
  type PersonCardFixture,
} from "./person-card.integration-fixtures.js";

const describeWithDatabase =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("person card cleanup undo and memory slots", () => {
  let fixture: PersonCardFixture;

  beforeEach(async () => {
    await resetPersonCardTables();
    fixture = await createPersonCardFixture();
  });

  afterAll(closeDatabase);

  const owner = (content: string, minutesAgo: number, attribute?: string) =>
    insertOwnerRecord(fixture, content, minutesAgo, attribute);

  async function statuses(ids: string[]): Promise<Map<string, string>> {
    const rows = await database().query<{ claim_status: string; id: string }>(
      "SELECT id, claim_status FROM memory_items_all WHERE id = ANY($1::uuid[])",
      [ids],
    );
    return new Map(rows.rows.map((row) => [row.id, row.claim_status]));
  }

  it("brings back records that stood beside their kept record when they were cleaned", async () => {
    const latte = await owner("Пьёт латте", 120, "кофе");
    const coffee = await owner("Пьёт латте без сахара", 110, "кофе");
    const moscow = await owner("Живёт в Москве", 100, "город");
    const kazan = await owner("Переехал в Казань", 90, "город");
    const tea = await owner("Любит чай", 80, "напитки");
    const sameTea = await owner("Любит чай", 70, "вечер");
    const cleaned = await publishOwnerCleanup(fixture, [
      { item: latte, kept: coffee, reason: "duplicate" },
      { item: moscow, kept: kazan, reason: "refuted" },
      { item: tea, kept: sameTea, reason: "duplicate" },
    ]);
    expect(cleaned.cleaned).toBe(3);
    expect(await undoPersonCardCleanups({ buildId: null })).toEqual({
      changedSince: 0,
      restored: 3,
    });
    expect([...(await statuses([latte.id, moscow.id, tea.id])).values()]).toEqual([
      "active",
      "active",
      "active",
    ]);
  });

  it("brings back two records of one slot that one build cleaned", async () => {
    const latte = await owner("Пьёт латте", 120, "кофе");
    const cappuccino = await owner("Пьёт капучино", 110, "кофе");
    const kept = await owner("Любит кофе с молоком", 100);
    const cleaned = await publishOwnerCleanup(fixture, [
      { item: latte, kept, reason: "duplicate" },
      { item: cappuccino, kept, reason: "duplicate" },
    ]);
    expect(await undoPersonCardCleanups({ buildId: cleaned.buildId })).toEqual({
      changedSince: 0,
      restored: 2,
    });
  });

  it.each([true, false])(
    "brings back two records that stood together however two builds hid them (newer first: %s)",
    async (newerFirst) => {
      const older = await owner("Пьёт латте", 120, "кофе");
      const newer = await owner("Пьёт латте по утрам", 110, "кофе");
      const olderText = await owner("Пьёт эспрессо", 100);
      const newerText = await owner("Пьёт эспрессо", 90, "напитки");
      const kept = await owner("Любит кофе с молоком", 80);
      const [first, second] = newerFirst ? [newer, older] : [older, newer];
      const [firstText, secondText] = newerFirst ? [newerText, olderText] : [olderText, newerText];
      await publishOwnerCleanup(fixture, [
        { item: first, kept, reason: "duplicate" },
        { item: firstText, kept, reason: "duplicate" },
      ]);
      await publishOwnerCleanup(fixture, [
        { item: second, kept, reason: "duplicate" },
        { item: secondText, kept, reason: "duplicate" },
      ]);
      expect(await undoPersonCardCleanups({ buildId: null })).toEqual({
        changedSince: 0,
        restored: 4,
      });
    },
  );

  it("leaves a record unread when its cleanup was skipped, so the profile block shows it", async () => {
    const moscow = await owner("Живёт в Москве", 120);
    const kazan = await owner("Переехал в Казань", 110);
    const car = await owner("Ездит на E60", 100);
    const build = await claimOwnerBuild(fixture);
    // The person deletes the newer record while the model works: the cleanup is skipped.
    await memoryRepository.deleteByRef(fixture.ownerAuth, kazan.memoryRef, "slots:delete-kazan");
    const result = await publishPersonCard(
      ownerPublishInput(build, car, [{ item: moscow, kept: kazan, reason: "refuted" }]),
    );
    expect(result).toMatchObject({ cleaned: 0, cleanupSkipped: 1 });
    const read = await database().query<{ memory_item_id: string }>(
      "SELECT memory_item_id FROM person_card_reads",
    );
    expect(read.rows.map((row) => row.memory_item_id).sort()).toEqual([kazan.id, car.id].sort());
  });

  it("brings back only the newest version of a slot two builds hid one after another", async () => {
    const moscow = await owner("Живёт в Москве", 120, "город");
    const moved = await owner("Переехал из Москвы", 110);
    expect(
      (await publishOwnerCleanup(fixture, [{ item: moscow, kept: moved, reason: "refuted" }]))
        .cleaned,
    ).toBe(1);
    // The slot looked empty to memory writes: a new version went in, and the next build hid it.
    const kazan = await owner("Живёт в Казани", 5, "город");
    const kazanAgain = await owner("Живёт в Казани с прошлого года", 1);
    expect(
      (await publishOwnerCleanup(fixture, [{ item: kazan, kept: kazanAgain, reason: "duplicate" }]))
        .cleaned,
    ).toBe(1);
    expect(await undoPersonCardCleanups({ buildId: null })).toEqual({
      changedSince: 1,
      restored: 1,
    });
    expect(await statuses([moscow.id, kazan.id])).toEqual(
      new Map([
        [moscow.id, "superseded"],
        [kazan.id, "active"],
      ]),
    );
  });
});
